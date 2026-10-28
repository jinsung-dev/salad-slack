import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { WebSocket } from "ws";

// Socket Mode (Slack's protocol, https://api.slack.com/apis/socket-mode): an
// app opens a WebSocket to Chatter and receives envelopes it acknowledges by
// id, so it needs no public URL. Connections live on whichever node the app
// reached; an envelope is published to every node, and exactly one node that
// holds a connection for the app claims it in Redis and sends it there. The
// acknowledgement travels back to the node that sent the envelope.

const TICKET_TTL_S = 30;
const CLAIM_TTL_S = 120;
const HEARTBEAT_MS = 30_000;
/** Slack allows ten connections per app. */
export const MAX_CONNECTIONS_PER_APP = 10;

export type EnvelopeType = "events_api" | "slash_commands" | "interactive";

export interface Envelope {
  envelope_id: string;
  type: EnvelopeType;
  payload: unknown;
  accepts_response_payload: boolean;
  retry_attempt: number;
  retry_reason: string;
}

/** What came back for an envelope: the app's acknowledgement (with any response payload), or nothing in time. */
export type Delivery = { acked: true; payload: unknown } | { acked: false };

type Wire =
  | { kind: "envelope"; appId: string; origin: string; envelope: Envelope }
  | { kind: "ack"; origin: string; envelopeId: string; payload: unknown }
  | { kind: "disconnect"; appId: string; reason: string };

interface Connection {
  appId: string;
  alive: boolean;
}

export class SocketModeHub {
  private readonly nodeId = randomUUID();
  private readonly sockets = new Map<WebSocket, Connection>();
  /** Envelopes this node sent, waiting for their acknowledgement. */
  private readonly waiters = new Map<string, (payload: unknown) => void>();
  /** Envelopes this node delivered to a local socket: who to tell about the ack. */
  private readonly delivered = new Map<string, { origin: string; at: number }>();
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly channel: string;
  private readonly timer: NodeJS.Timeout;

  private constructor(
    redisUrl: string,
    private readonly prefix: string,
    private readonly log: (msg: string, err: unknown) => void,
  ) {
    this.pub = new Redis(redisUrl, { lazyConnect: true });
    this.sub = new Redis(redisUrl, { lazyConnect: true });
    this.channel = `${prefix}socket-mode`;
    this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.timer.unref();
  }

  static async start(redisUrl: string, prefix: string, log: (msg: string, err: unknown) => void) {
    const hub = new SocketModeHub(redisUrl, prefix, log);
    await Promise.all([hub.pub.connect(), hub.sub.connect()]);
    hub.sub.on("message", (_channel, raw) => void hub.receive(raw).catch((err) => hub.log("socket mode relay failed", err)));
    await hub.sub.subscribe(hub.channel);
    return hub;
  }

  /** A single-use ticket for the WebSocket URL `apps.connections.open` hands out. */
  async issueTicket(appId: string): Promise<string> {
    const ticket = randomBytes(24).toString("base64url");
    await this.pub.set(`${this.prefix}socket-mode:ticket:${ticket}`, appId, "EX", TICKET_TTL_S);
    return ticket;
  }

  /** The app a ticket was issued to; the ticket is spent either way. */
  async redeemTicket(ticket: string): Promise<string | null> {
    return this.pub.getdel(`${this.prefix}socket-mode:ticket:${ticket}`);
  }

  /** Connections for the app on this node; the cap applies per node. */
  localConnections(appId: string): number {
    let count = 0;
    for (const c of this.sockets.values()) if (c.appId === appId) count++;
    return count;
  }

  add(appId: string, socket: WebSocket, connectionInfo: Record<string, unknown>): void {
    const connection: Connection = { appId, alive: true };
    this.sockets.set(socket, connection);
    socket.on("pong", () => (connection.alive = true));
    socket.on("message", (raw) => this.acknowledge(String(raw)));
    socket.on("close", () => this.sockets.delete(socket));
    socket.send(
      JSON.stringify({
        type: "hello",
        num_connections: this.localConnections(appId),
        debug_info: { host: "chatter", approximate_connection_time: 18060 },
        connection_info: connectionInfo,
      }),
    );
  }

  /**
   * Sends an envelope to one of the app's connections and waits for its
   * acknowledgement. Unacknowledged when the app has no connection.
   */
  async send(
    appId: string,
    type: EnvelopeType,
    payload: unknown,
    { acceptsResponsePayload = false, retryAttempt = 0, retryReason = "", timeoutMs = 3000 } = {},
  ): Promise<Delivery> {
    const envelope: Envelope = {
      envelope_id: randomUUID(),
      type,
      payload,
      accepts_response_payload: acceptsResponsePayload,
      retry_attempt: retryAttempt,
      retry_reason: retryReason,
    };
    const acked = new Promise<Delivery>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(envelope.envelope_id);
        resolve({ acked: false });
      }, timeoutMs);
      this.waiters.set(envelope.envelope_id, (ackPayload) => {
        clearTimeout(timer);
        this.waiters.delete(envelope.envelope_id);
        resolve({ acked: true, payload: ackPayload });
      });
    });
    await this.publish({ kind: "envelope", appId, origin: this.nodeId, envelope });
    return acked;
  }

  /** Closes every connection of the app on all nodes (Socket Mode turned off, token reissued, app deleted). */
  async disconnect(appId: string, reason = "link_disabled"): Promise<void> {
    await this.publish({ kind: "disconnect", appId, reason });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const socket of this.sockets.keys()) socket.terminate();
    this.sockets.clear();
    this.sub.disconnect();
    this.pub.disconnect();
  }

  private async publish(wire: Wire) {
    await this.pub.publish(this.channel, JSON.stringify(wire));
  }

  private async receive(raw: string) {
    const wire = JSON.parse(raw) as Wire;
    if (wire.kind === "ack") {
      if (wire.origin === this.nodeId) this.waiters.get(wire.envelopeId)?.(wire.payload);
      return;
    }
    if (wire.kind === "disconnect") {
      for (const [socket, c] of this.sockets) {
        if (c.appId !== wire.appId) continue;
        socket.send(JSON.stringify({ type: "disconnect", reason: wire.reason }));
        socket.close(1000);
      }
      return;
    }
    const open = [...this.sockets].filter(([s, c]) => c.appId === wire.appId && s.readyState === s.OPEN).map(([s]) => s);
    if (open.length === 0) return;
    const claimed = await this.pub.set(`${this.prefix}socket-mode:claim:${wire.envelope.envelope_id}`, this.nodeId, "EX", CLAIM_TTL_S, "NX");
    if (claimed !== "OK") return;
    this.delivered.set(wire.envelope.envelope_id, { origin: wire.origin, at: Date.now() });
    open[Math.floor(Math.random() * open.length)]!.send(JSON.stringify(wire.envelope));
  }

  /** `{ envelope_id, payload? }` from the app. */
  private acknowledge(raw: string) {
    let ack: unknown;
    try {
      ack = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof ack !== "object" || ack === null) return;
    const { envelope_id: envelopeId, payload } = ack as { envelope_id?: unknown; payload?: unknown };
    if (typeof envelopeId !== "string") return;
    const delivered = this.delivered.get(envelopeId);
    if (!delivered) return;
    this.delivered.delete(envelopeId);
    void this.publish({ kind: "ack", origin: delivered.origin, envelopeId, payload: payload ?? null }).catch((err) => this.log("socket mode ack failed", err));
  }

  private sweep(): void {
    for (const [socket, c] of this.sockets) {
      if (!c.alive) {
        socket.terminate();
        continue;
      }
      c.alive = false;
      socket.ping();
    }
    const stale = Date.now() - CLAIM_TTL_S * 1000;
    for (const [id, d] of this.delivered) if (d.at < stale) this.delivered.delete(id);
  }
}
