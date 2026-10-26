import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App, Channel, CommandInfo, EphemeralMessage, Member, Message, MessagePage, Workspace } from "@chatter/shared";
import { isPrivateAddress, OutboundError, postSigned, signature } from "../src/outbound";
import { connect, signIn, uniqueName, useCluster, type Client } from "./helpers";

const { urls } = useCluster(1, { allowPrivateAppUrls: true });
const base = () => urls[0]!;
const ws = (id: string, rest = "") => `/api/workspaces/${id}${rest}`;

// A stand-in for an app's server: records what Chatter sends and answers as each test says.
interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: any;
}
const received: Received[] = [];
type Responder = (body: any) => { status?: number; json?: unknown; delayMs?: number };
const responders = new Map<string, Responder>();
const appServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    received.push({ path: req.url!, headers: req.headers, raw, body });
    const answer = responders.get(req.url!)?.(body) ?? {};
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    if (res.destroyed) return;
    res.writeHead(answer.status ?? 200, answer.json === undefined ? {} : { "content-type": "application/json" });
    res.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
  });
});
let appBase = "";
beforeAll(async () => {
  await new Promise<void>((r) => appServer.listen(0, "127.0.0.1", r));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => appServer.close(() => r())));

const waitFor = async <T,>(find: () => T | undefined, timeoutMs = 3000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const bot = (token: string) => async <T = any>(method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base()}/api/bot/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (r.status === 204 ? null : await r.json()) as T };
};

async function setup() {
  const owner = await signIn(base(), "owner");
  const w = (await owner.call<Workspace>("POST", "/api/workspaces", { name: "Apps" })).body;
  const channel = (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName() })).body;
  const created = await owner.call<App>("POST", ws(w.id, "/apps"), { name: "Deploy Bot" });
  expect(created.status).toBe(201);
  const app = created.body;
  const configure = (patch: Partial<Pick<App, "scopes" | "eventsUrl" | "eventTypes" | "interactivityUrl">>) =>
    owner.call<App>("PUT", ws(w.id, `/apps/${app.id}`), {
      name: app.name,
      scopes: [],
      eventsUrl: null,
      eventTypes: [],
      interactivityUrl: null,
      ...patch,
    });
  const addBotTo = (channelId: string) => owner.call("POST", `/api/channels/${channelId}/members`, { userIds: [app.botUserId] });
  return { owner, w, channel, app, token: app.token!, configure, addBotTo };
}

describe("apps and bot users", () => {
  it("creates an app with a bot member, shows its token once, and keeps it for admins", async () => {
    const { owner, w, app } = await setup();
    expect(app.token).toMatch(/^xcb-/);
    expect(app.signingSecret).toHaveLength(48);
    const members = (await owner.call<Member[]>("GET", ws(w.id, "/members"))).body;
    expect(members.find((m) => m.id === app.botUserId)).toMatchObject({ displayName: "Deploy Bot", isBot: true, role: "member" });
    expect((await owner.call<App[]>("GET", ws(w.id, "/apps"))).body[0]!.token).toBeUndefined();

    const member = await signIn(base(), "member");
    const inv = (await owner.call("POST", ws(w.id, "/invites"), { role: "member" })).body as { url: string };
    await member.call("POST", `/api/invites/${inv.url.split("/invite/")[1]}/accept`);
    expect((await member.call("POST", ws(w.id, "/apps"), { name: "x" })).status).toBe(403);
    expect((await owner.call("PUT", ws(w.id, `/members/${app.botUserId}/role`), { role: "guest" })).body).toEqual({ error: "managed_by_app" });
    expect((await owner.call("DELETE", ws(w.id, `/members/${app.botUserId}`))).status).toBe(400);
  });

  it("serves the bot API within scopes and the conversations the bot is in", async () => {
    const { channel, app, token, configure, addBotTo, owner, w } = await setup();
    const call = bot(token);
    expect((await bot("xcb-wrong")("GET", "auth.test")).status).toBe(401);
    expect((await call("GET", "auth.test")).body).toMatchObject({ appId: app.id, botUserId: app.botUserId, workspaceId: w.id, scopes: [] });
    expect((await call("POST", "chat.postMessage", { channelId: channel.id, text: "hi" })).body).toEqual({ error: "missing_scope", needed: "chat:write" });

    await configure({ scopes: ["chat:write", "channels:read", "channels:history", "users:read"] });
    expect((await call("POST", "chat.postMessage", { channelId: channel.id, text: "hi" })).status).toBe(404); // not added yet
    await addBotTo(channel.id);
    const blocks = [
      { type: "section", text: "*배포* 준비 완료", fields: ["버전: 1.2", "환경: prod"] },
      { type: "actions", elements: [{ type: "button", text: "승인", actionId: "approve", style: "primary" }] },
    ];
    const posted = await call<Message>("POST", "chat.postMessage", { channelId: channel.id, text: "배포 준비 완료", blocks });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ text: "배포 준비 완료", blocks, author: { id: app.botUserId, displayName: "Deploy Bot" } });
    const bad = { type: "actions", elements: [{ type: "button", text: "x", actionId: "a", url: "https://example.com" }] };
    expect((await call("POST", "chat.postMessage", { channelId: channel.id, text: "x", blocks: [bad] })).status).toBe(400);

    expect((await call<Channel[]>("GET", "conversations.list")).body.map((c) => c.id)).toContain(channel.id);
    await owner.call("POST", `/api/channels/${channel.id}/messages`, { text: "from a person", clientMsgId: crypto.randomUUID() });
    const history = (await call<MessagePage>("GET", `conversations.history?channelId=${channel.id}`)).body;
    expect(history.messages.map((m) => m.text)).toEqual(["배포 준비 완료", "from a person"]);
    expect((await call<Member[]>("GET", "users.list")).body.map((m) => m.id)).toContain(owner.id);

    const reissued = (await owner.call<App>("POST", ws(w.id, `/apps/${app.id}/token`))).body;
    expect((await call("GET", "auth.test")).status).toBe(401);
    expect((await bot(reissued.token!)("GET", "auth.test")).status).toBe(200);
  });
});

describe("event subscriptions", () => {
  it("sends signed message and app_mention events from conversations the bot is in, retrying failures", async () => {
    const { owner, channel, app, w, configure, addBotTo } = await setup();
    const path = `/events-${app.id}`;
    let failures = 1;
    responders.set(path, () => (failures-- > 0 ? { status: 500 } : { status: 200 }));
    await configure({ scopes: ["chat:write"], eventsUrl: `${appBase}${path}`, eventTypes: ["message", "app_mention"] });
    const elsewhere = (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName() })).body;
    await addBotTo(channel.id);

    await owner.call("POST", `/api/channels/${elsewhere.id}/messages`, { text: "not for the bot", clientMsgId: crypto.randomUUID() });
    const msg = (await owner.call<Message>("POST", `/api/channels/${channel.id}/messages`, { text: `hey <@${app.botUserId}>`, clientMsgId: crypto.randomUUID() }))
      .body;
    const events = () => received.filter((r) => r.path === path && r.body.event.message.id === msg.id);
    await waitFor(() => (events().filter((e) => e.headers["x-chatter-retry-num"] === "1").length >= 1 ? true : undefined), 4000);
    const types = new Set(events().map((e) => e.body.event.type));
    expect(types).toEqual(new Set(["message", "app_mention"]));
    const first = events()[0]!;
    expect(first.body).toMatchObject({ type: "event_callback", appId: app.id, workspaceId: w.id, event: { channelId: channel.id } });
    const ts = Number(first.headers["x-chatter-request-timestamp"]);
    expect(first.headers["x-chatter-signature"]).toBe(signature(app.signingSecret, ts, first.raw));
    expect(received.some((r) => r.path === path && r.body.event.message.text === "not for the bot")).toBe(false);

    // The bot's own messages raise nothing.
    const own = (await bot(app.token!)<Message>("POST", "chat.postMessage", { channelId: channel.id, text: "mine" })).body;
    await new Promise((r) => setTimeout(r, 300));
    expect(received.some((r) => r.path === path && r.body.event.message.id === own.id)).toBe(false);
  });
});

describe("slash commands", () => {
  async function withCommand(command: string, responder: Responder) {
    const ctx = await setup();
    const path = `/cmd-${ctx.app.id}`;
    responders.set(path, responder);
    const created = await ctx.owner.call("POST", ws(ctx.w.id, `/apps/${ctx.app.id}/commands`), { command, url: `${appBase}${path}`, description: "배포", usageHint: "[환경]" });
    expect(created.status).toBe(201);
    return { ...ctx, path };
  }
  const run = (who: Client, channelId: string, command: string, text = "") => who.call("POST", `/api/channels/${channelId}/commands`, { command, text });

  it("posts the app's in-channel answer as its bot, signed request included", async () => {
    const name = `deploy${crypto.randomUUID().slice(0, 4)}`;
    const { owner, channel, app, path, w } = await withCommand(name, (body) => ({ json: { text: `배포 시작: ${body.text}`, responseType: "in_channel" } }));
    const socket = connect(base(), owner.cookie);
    await socket.ready();
    expect((await run(owner, channel.id, name, "prod")).status).toBe(204);
    const req = received.find((r) => r.path === path)!;
    expect(req.body).toMatchObject({ type: "slash_command", command: `/${name}`, text: "prod", channelId: channel.id, workspaceId: w.id, user: { id: owner.id } });
    expect(req.body.responseUrl).toContain("/api/response-urls/");
    const created = await socket.next("message.created", (e) => e.message.channelId === channel.id);
    expect(created.message).toMatchObject({ text: "배포 시작: prod", author: { id: app.botUserId } });
    expect((await owner.call<CommandInfo[]>("GET", ws(w.id, "/commands"))).body).toContainEqual({ command: name, description: "배포", usageHint: "[환경]", appName: "Deploy Bot" });
    expect((await owner.call("POST", ws(w.id, `/apps/${app.id}/commands`), { command: name, url: `${appBase}/x` })).status).toBe(409);
    socket.ws.close();
  });

  it("shows ephemeral answers to the person who ran it only, and errors on a slow app", async () => {
    const name = `who${crypto.randomUUID().slice(0, 4)}`;
    let slow = false;
    const { owner, w, channel } = await withCommand(name, () => (slow ? { delayMs: 3500, json: { text: "late" } } : { json: { text: "only you" } }));
    const other = await signIn(base(), "other");
    const inv = (await owner.call("POST", ws(w.id, "/invites"), { role: "member" })).body as { url: string };
    await other.call("POST", `/api/invites/${inv.url.split("/invite/")[1]}/accept`);
    await other.call("POST", `/api/channels/${channel.id}/join`);
    const [mine, theirs] = [connect(base(), owner.cookie), connect(base(), other.cookie)];
    await Promise.all([mine.ready(), theirs.ready()]);

    await run(owner, channel.id, name);
    expect((await mine.next("ephemeral")).message).toMatchObject({ channelId: channel.id, text: "only you", author: { displayName: "Deploy Bot" } });
    await theirs.none("ephemeral");
    expect((await owner.call<MessagePage>("GET", `/api/channels/${channel.id}/messages`)).body.messages).toEqual([]);

    slow = true;
    await run(owner, channel.id, name);
    expect((await mine.next("ephemeral", (e: { message: EphemeralMessage }) => e.message.text.includes("3초"), 5000)).message.channelId).toBe(channel.id);
    expect((await run(other, channel.id, "nope")).status).toBe(404);
    for (const s of [mine, theirs]) s.ws.close();
  });

  it("accepts late answers through the response URL a limited number of times", async () => {
    const name = `late${crypto.randomUUID().slice(0, 4)}`;
    const { owner, channel, path } = await withCommand(name, () => ({ status: 200 }));
    await run(owner, channel.id, name, "x");
    const responseUrl = received.find((r) => r.path === path)!.body.responseUrl as string;
    const later = (text: string) =>
      fetch(`${base()}${new URL(responseUrl).pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, responseType: "in_channel" }) });
    for (let i = 1; i <= 5; i++) expect((await later(`update ${i}`)).status).toBe(204);
    expect((await later("one too many")).status).toBe(404);
    const texts = (await owner.call<MessagePage>("GET", `/api/channels/${channel.id}/messages`)).body.messages.map((m) => m.text);
    expect(texts).toEqual(["update 1", "update 2", "update 3", "update 4", "update 5"]);
  });
});

describe("interactive blocks", () => {
  it("forwards button clicks to the app, which can replace the message", async () => {
    const { owner, channel, app, token, configure, addBotTo } = await setup();
    const path = `/interact-${app.id}`;
    responders.set(path, (body) => ({ json: { text: `${body.user.displayName} 님이 승인함`, replaceOriginal: true } }));
    await configure({ scopes: ["chat:write"], interactivityUrl: `${appBase}${path}` });
    await addBotTo(channel.id);
    const blocks = [{ type: "actions", elements: [{ type: "button", text: "승인", actionId: "approve", value: "v1.2" }] }];
    const msg = (await bot(token)<Message>("POST", "chat.postMessage", { channelId: channel.id, text: "승인할까요?", blocks })).body;
    const socket = connect(base(), owner.cookie);
    await socket.ready();

    expect((await owner.call("POST", `/api/messages/${msg.id}/actions`, { actionId: "missing" })).status).toBe(400);
    expect((await owner.call("POST", `/api/messages/${msg.id}/actions`, { actionId: "approve", value: "v1.2" })).status).toBe(204);
    const req = received.find((r) => r.path === path)!;
    expect(req.body).toMatchObject({ type: "block_actions", messageId: msg.id, action: { actionId: "approve", value: "v1.2" }, user: { id: owner.id } });
    const updated = await socket.next("message.updated", (e) => e.message.id === msg.id);
    expect(updated.message).toMatchObject({ text: "owner 님이 승인함", blocks: null });

    // A person's message has no actions to click.
    const mine = (await owner.call<Message>("POST", `/api/channels/${channel.id}/messages`, { text: "hi", clientMsgId: crypto.randomUUID() })).body;
    expect((await owner.call("POST", `/api/messages/${mine.id}/actions`, { actionId: "approve" })).status).toBe(400);
    socket.ws.close();
  });
});

describe("outbound requests to app URLs", () => {
  const strict = { allowPrivate: false };
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.202", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "142.250.196.110", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses plain HTTP and anything that reaches a private address", async () => {
    const reason = (url: string) => postSigned(url, {}, "s", strict, { timeoutMs: 2000 }).then(() => "sent", (e: OutboundError) => e.reason);
    expect(await reason("http://example.com/hook")).toBe("invalid_url");
    expect(await reason("https://127.0.0.1/hook")).toBe("blocked_address");
    expect(await reason("https://[::1]/hook")).toBe("blocked_address");
    // A name that resolves to loopback is caught at connect time.
    expect(await reason("https://localhost/hook")).toBe("blocked_address");
  });
});
