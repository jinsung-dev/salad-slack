import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { clientEvent, type ClientEvent, type PresenceMap, type PresenceStatus, type ServerEvent } from "@chatter/shared";
import type { WebSocket } from "ws";

const HEARTBEAT_MS = 30_000;
const PRESENCE_REFRESH_MS = 20_000;
const PRESENCE_TTL_S = 60;

export interface Target {
  users: Iterable<string>;
}
type WireTarget = { users: string[] };

interface SocketState {
  userId: string;
  active: boolean;
  /** The tab is visible and focused; unknown until the client says. */
  focused: boolean;
  alive: boolean;
}

export type ClientEventHandler = (userId: string, event: Extract<ClientEvent, { type: "typing" }>) => void;
/** Who may see a person's presence: people who share a workspace with them. */
export type PresenceAudience = (userId: string) => Promise<string[]>;

/**
 * Cluster-wide fan-out of server events plus presence and tab focus.
 *
 * Every node publishes events to one Redis channel and delivers the ones
 * addressed to its own sockets, so a send reaches users on any node. Presence
 * is each node's own socket counts, rewritten whole into a hash that expires
 * if the node dies; a user's status is the union across live nodes.
 */
export class RealtimeHub {
  private readonly nodeId = randomUUID();
  private readonly sockets = new Map<WebSocket, SocketState>();
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly channel: string;
  private readonly nodeKey: string;
  private readonly timers: NodeJS.Timeout[] = [];
  private onClientEvent: ClientEventHandler = () => {};
  private presenceAudience: PresenceAudience = async (userId) => [userId];

  private constructor(
    redisUrl: string,
    private readonly prefix: string,
    private readonly log: (msg: string, err: unknown) => void,
  ) {
    this.pub = new Redis(redisUrl, { lazyConnect: true });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
    this.channel = `${prefix}events`;
    this.nodeKey = `${prefix}presence:node:${this.nodeId}`;
  }

  static async start(redisUrl: string, prefix: string, log: (msg: string, err: unknown) => void) {
    const hub = new RealtimeHub(redisUrl, prefix, log);
    await Promise.all([hub.pub.connect(), hub.sub.connect()]);
    hub.sub.on("message", (_channel, raw) => hub.deliver(raw));
    await hub.sub.subscribe(hub.channel);
    hub.timers.push(setInterval(() => hub.sweep(), HEARTBEAT_MS), setInterval(() => void hub.syncPresence(), PRESENCE_REFRESH_MS));
    for (const t of hub.timers) t.unref();
    return hub;
  }

  handleClientEvents(handler: ClientEventHandler) {
    this.onClientEvent = handler;
  }

  setPresenceAudience(audience: PresenceAudience) {
    this.presenceAudience = audience;
  }

  add(userId: string, socket: WebSocket): void {
    const state: SocketState = { userId, active: true, focused: false, alive: true };
    this.sockets.set(socket, state);
    socket.on("pong", () => (state.alive = true));
    socket.on("message", (raw) => this.receive(state, String(raw)));
    socket.on("close", () => {
      this.sockets.delete(socket);
      void this.presenceChanged(userId);
    });
    socket.send(JSON.stringify({ type: "hello", userId } satisfies ServerEvent));
    void this.presenceChanged(userId);
  }

  publish(target: Target, event: ServerEvent): void {
    const wire: WireTarget = { users: [...target.users] };
    if (wire.users.length === 0) return;
    this.pub.publish(this.channel, JSON.stringify({ target: wire, event })).catch((err) => this.log("publish failed", err));
  }

  async presence(): Promise<PresenceMap> {
    const result: PresenceMap = {};
    for (const hash of await this.nodeHashes()) {
      for (const [field, count] of Object.entries(hash)) {
        if (field.includes(":") || Number(count) <= 0) continue;
        const active = Number(hash[`a:${field}`] ?? 0) > 0;
        if (active || result[field] === undefined) result[field] = active ? "active" : "away";
      }
    }
    return result;
  }

  /** Users with a focused tab on any node: they are looking at Chatter. */
  async focusedUsers(): Promise<Set<string>> {
    const focused = new Set<string>();
    for (const hash of await this.nodeHashes()) {
      for (const [field, count] of Object.entries(hash)) {
        if (field.startsWith("f:") && Number(count) > 0) focused.add(field.slice(2));
      }
    }
    return focused;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const socket of this.sockets.keys()) socket.terminate();
    this.sockets.clear();
    await this.pub.del(this.nodeKey).catch(() => {});
    this.sub.disconnect();
    this.pub.disconnect();
  }

  private receive(state: SocketState, raw: string) {
    let parsed: ClientEvent;
    try {
      const result = clientEvent.safeParse(JSON.parse(raw));
      if (!result.success) return;
      parsed = result.data;
    } catch {
      return;
    }
    if (parsed.type === "focus") {
      if (state.focused === parsed.focused) return;
      state.focused = parsed.focused;
      void this.syncPresence().catch((err) => this.log("focus update failed", err));
      return;
    }
    if (parsed.type === "presence") {
      const active = parsed.status === "active";
      if (state.active === active) return;
      state.active = active;
      void this.presenceChanged(state.userId);
      return;
    }
    this.onClientEvent(state.userId, parsed);
  }

  private deliver(raw: string) {
    const { target, event } = JSON.parse(raw) as { target: WireTarget; event: ServerEvent };
    const payload = JSON.stringify(event);
    const users = new Set(target.users);
    for (const [socket, { userId }] of this.sockets) {
      if (users.has(userId)) socket.send(payload);
    }
  }

  private async presenceChanged(userId: string) {
    try {
      await this.syncPresence();
      const status: PresenceStatus = (await this.presence())[userId] ?? "offline";
      this.publish({ users: await this.presenceAudience(userId) }, { type: "presence.changed", userId, status });
    } catch (err) {
      this.log("presence update failed", err);
    }
  }

  /** Local sockets are the truth for this node; rewrite its hash whole. */
  private async syncPresence() {
    const counts = new Map<string, number>();
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const { userId, active, focused } of this.sockets.values()) {
      bump(userId);
      if (active) bump(`a:${userId}`);
      if (focused) bump(`f:${userId}`);
    }
    const tx = this.pub.multi().del(this.nodeKey);
    if (counts.size > 0) tx.hset(this.nodeKey, Object.fromEntries(counts)).expire(this.nodeKey, PRESENCE_TTL_S);
    await tx.exec();
  }

  private async nodeHashes(): Promise<Record<string, string>[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.pub.scan(cursor, "MATCH", `${this.prefix}presence:node:*`, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return [];
    const replies = await keys.reduce((p, key) => p.hgetall(key), this.pub.pipeline()).exec();
    return (replies ?? []).map(([, value]) => (value ?? {}) as Record<string, string>);
  }

  private sweep(): void {
    for (const [socket, state] of this.sockets) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }
}
