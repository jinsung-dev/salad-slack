import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { slackId, type App, type Channel, type Message, type Workspace } from "@chatter/shared";
import { connect, signIn, uniqueName, useCluster } from "./helpers";

// Slack apps (Bolt, slack_sdk, Hermes) against /api/slack: Web API shapes,
// id and text conversion, and Socket Mode across two nodes.

const { urls } = useCluster(2, { allowPrivateAppUrls: true });
const base = () => urls[0]!;
const other = () => urls[1]!;
const ws = (id: string, rest = "") => `/api/workspaces/${id}${rest}`;

/** A Slack Web API call: form-encoded like slack_sdk's default, or JSON. */
const slack =
  (token: string, url = base()) =>
  async (method: string, params: Record<string, unknown> = {}, { json = false } = {}) => {
    const body = json
      ? JSON.stringify(params)
      : new URLSearchParams(Object.entries(params).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])).toString();
    const r = await fetch(`${url}/api/slack/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": json ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded" },
      body,
    });
    expect(r.status).toBe(200);
    return { body: (await r.json()) as any, scopes: r.headers.get("x-oauth-scopes") };
  };

const ALL_SCOPES = ["chat:write", "channels:read", "channels:history", "users:read"] as const;

async function setup({ socketMode = false } = {}) {
  const owner = await signIn(base(), "owner");
  const w = (await owner.call<Workspace>("POST", "/api/workspaces", { name: "Slack" })).body;
  const channel = (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName() })).body;
  const app = (await owner.call<App>("POST", ws(w.id, "/apps"), { name: "Hermes" })).body;
  const configure = (patch: Partial<App> = {}) =>
    owner.call<App>("PUT", ws(w.id, `/apps/${app.id}`), {
      name: app.name,
      scopes: ALL_SCOPES,
      eventsUrl: null,
      eventTypes: ["message", "app_mention"],
      interactivityUrl: null,
      socketMode,
      ...patch,
    });
  await configure();
  await owner.call("POST", `/api/channels/${channel.id}/members`, { userIds: [app.botUserId] });
  const ids = { team: slackId("T", w.id), channel: slackId("C", channel.id), bot: slackId("U", app.botUserId), owner: slackId("U", owner.id) };
  return { owner, w, channel, app, token: app.token!, call: slack(app.token!), configure, ids };
}

/** A Socket Mode client: frames received, and acknowledgements sent by envelope id. */
async function socketClient(url: string) {
  const socket = new WebSocket(url);
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)));
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  const next = async (where: (f: any) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = frames.findIndex(where);
      if (i >= 0) return frames.splice(i, 1)[0];
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
  };
  const ack = (envelope: { envelope_id: string }, payload?: unknown) =>
    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id, ...(payload === undefined ? {} : { payload }) }));
  const hello = await next((f) => f.type === "hello");
  return { socket, frames, next, ack, hello, closed };
}

async function openSocket(ctx: Awaited<ReturnType<typeof setup>>) {
  const issued = (await ctx.owner.call<App>("POST", ws(ctx.w.id, `/apps/${ctx.app.id}/app-token`))).body;
  expect(issued.appToken).toMatch(/^xapp-/);
  const opened = await slack(issued.appToken!)("apps.connections.open");
  expect(opened.body).toMatchObject({ ok: true, url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/api\/slack\/socket\?ticket=/) });
  return { appToken: issued.appToken!, client: await socketClient(opened.body.url), url: opened.body.url as string };
}

const post = (client: Awaited<ReturnType<typeof signIn>>, channelId: string, text: string, extra: Record<string, unknown> = {}, url?: string) =>
  client.call<Message>("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: randomUUID(), ...extra }, url);

describe("Slack Web API", () => {
  it("authenticates like Slack and answers every call with ok and Slack error codes", async () => {
    const { call, ids, token, configure, app } = await setup();
    const auth = await call("auth.test");
    expect(auth.body).toMatchObject({ ok: true, team_id: ids.team, user_id: ids.bot, bot_id: slackId("B", app.botUserId), app_id: slackId("A", app.id), user: "Hermes", team: "Slack" });
    expect(auth.scopes).toContain("chat:write");
    expect(auth.scopes).toContain("im:history");
    expect(token).toMatch(/^xoxb-/);

    expect((await slack("xoxb-wrong")("auth.test")).body).toEqual({ ok: false, error: "invalid_auth" });
    // The token may also come as a parameter.
    const r = await fetch(`${base()}/api/slack/auth.test?token=${encodeURIComponent(token)}`);
    expect(((await r.json()) as any).ok).toBe(true);
    expect((await call("files.upload")).body).toEqual({ ok: false, error: "unknown_method" });
    expect((await call("chat.postMessage", { channel: "C000", text: "x" })).body).toEqual({ ok: false, error: "channel_not_found" });

    await configure({ scopes: ["channels:read"] });
    expect((await call("chat.postMessage", { channel: ids.channel, text: "x" })).body).toMatchObject({ ok: false, error: "missing_scope", needed: "chat:write" });
  });

  it("posts mrkdwn and Block Kit as Chatter messages, and reads them back in Slack's shape", async () => {
    const { owner, channel, call, ids, app } = await setup();
    const live = connect(base(), owner.cookie);
    await live.ready();

    const blocks = [
      { type: "header", text: { type: "plain_text", text: "배포" } },
      { type: "section", text: { type: "mrkdwn", text: "*준비* 완료 <@" + ids.owner + "> <https://example.com|링크>" }, accessory: { type: "button", action_id: "go", text: { type: "plain_text", text: "진행" }, style: "primary" } },
      { type: "rich_text", elements: [] },
      { type: "actions", elements: [{ type: "static_select", action_id: "pick" }, { type: "button", action_id: "stop", text: { type: "plain_text", text: "중지" }, value: "1" }] },
    ];
    const posted = await call("chat.postMessage", { channel: ids.channel, text: "a &lt; b &amp; <@" + ids.owner + "> <!here>", blocks });
    expect(posted.body).toMatchObject({ ok: true, channel: ids.channel, ts: expect.stringMatching(/^\d+\.\d{6}$/) });
    const created = await live.next("message.created", (e) => e.message.channelId === channel.id);
    expect(created.message).toMatchObject({ text: `a < b & <@${owner.id}> @here`, mentions: [owner.id], author: { id: app.botUserId } });
    expect(created.message.blocks).toEqual([
      { type: "section", text: "*배포*" },
      { type: "section", text: `*준비* 완료 <@${owner.id}> 링크 (https://example.com)` },
      { type: "actions", elements: [{ type: "button", text: "진행", actionId: "go", style: "primary" }] },
      { type: "actions", elements: [{ type: "button", text: "중지", actionId: "stop", value: "1" }] },
    ]);
    expect(posted.body.message).toMatchObject({ type: "message", user: ids.bot, bot_id: slackId("B", app.botUserId), text: `a &lt; b &amp; <@${ids.owner}> @here`, ts: posted.body.ts });

    // JSON bodies and markdown_text work too.
    const md = await call("chat.postMessage", { channel: ids.channel, markdown_text: "**굵게** and *기울임* [문서](https://docs.example)" }, { json: true });
    expect((await live.next("message.created", (e) => e.message.id !== created.message.id)).message.text).toBe("*굵게* and _기울임_ 문서 (https://docs.example)");

    const person = await post(owner, channel.id, "사람 <@" + app.botUserId + "> 글");
    const history = (await call("conversations.history", { channel: ids.channel, limit: 2 })).body;
    expect(history.messages.map((m: any) => m.text)).toEqual([`사람 <@${ids.bot}> 글`, "*굵게* and _기울임_ 문서 (https://docs.example)"]);
    expect(history.messages[0]).toMatchObject({ user: ids.owner, client_msg_id: person.body.clientMsgId, team: ids.team });
    expect(history.has_more).toBe(true);
    const older = (await call("conversations.history", { channel: ids.channel, cursor: history.response_metadata.next_cursor })).body;
    expect(older.messages.map((m: any) => m.ts)).toEqual([posted.body.ts]);
    expect(md.body.ok).toBe(true);

    const info = (await call("conversations.info", { channel: ids.channel })).body;
    expect(info.channel).toMatchObject({ id: ids.channel, name: channel.name, is_channel: true, is_private: false, is_member: true, is_im: false });
    const user = (await call("users.info", { user: ids.owner })).body;
    expect(user.user).toMatchObject({ id: ids.owner, team_id: ids.team, is_bot: false, name: "owner" });
    expect((await call("users.info", { user: "U" + "0".repeat(32) })).body.error).toBe("user_not_found");
    live.ws.close();
  });

  it("replies in threads, edits and deletes its own messages, reacts and opens DMs", async () => {
    const { owner, w, channel, call, ids, app } = await setup();
    const live = connect(base(), owner.cookie);
    await live.ready();
    const parent = (await post(owner, channel.id, "질문")).body;
    const parentTs = (await call("conversations.history", { channel: ids.channel })).body.messages[0].ts;

    const reply = (await call("chat.postMessage", { channel: ids.channel, text: "답변", thread_ts: parentTs })).body;
    expect(reply.message).toMatchObject({ thread_ts: parentTs, parent_user_id: ids.owner });
    expect((await live.next("message.created", (e) => e.message.parentId === parent.id)).message.text).toBe("답변");
    const thread = (await call("conversations.replies", { channel: ids.channel, ts: parentTs })).body;
    expect(thread.messages.map((m: any) => [m.ts, m.text])).toEqual([
      [parentTs, "질문"],
      [reply.ts, "답변"],
    ]);
    expect(thread.messages[0]).toMatchObject({ thread_ts: parentTs, reply_count: 1, reply_users: [ids.bot] });
    expect((await call("chat.postMessage", { channel: ids.channel, text: "x", thread_ts: "1.000001" })).body.error).toBe("thread_not_found");

    // Edits stream into the same message; only the bot's own.
    const updated = await call("chat.update", { channel: ids.channel, ts: reply.ts, text: "답변 (수정)" });
    expect(updated.body).toMatchObject({ ok: true, ts: reply.ts, text: "답변 (수정)" });
    expect((await live.next("message.updated", (e) => e.message.text === "답변 (수정)")).message.editedAt).not.toBeNull();
    expect((await call("chat.update", { channel: ids.channel, ts: parentTs, text: "x" })).body.error).toBe("cant_update_message");

    expect((await call("reactions.add", { channel: ids.channel, timestamp: parentTs, name: "eyes" })).body).toEqual({ ok: true });
    expect((await live.next("reaction.updated", (e) => e.messageId === parent.id)).reactions).toEqual([{ emoji: "👀", userIds: [app.botUserId] }]);
    expect((await call("reactions.add", { channel: ids.channel, timestamp: parentTs, name: "eyes" })).body.error).toBe("already_reacted");
    expect((await call("reactions.add", { channel: ids.channel, timestamp: parentTs, name: "no_such_emoji" })).body.error).toBe("invalid_name");
    expect((await call("reactions.remove", { channel: ids.channel, timestamp: parentTs, name: ":eyes:" })).body).toEqual({ ok: true });

    expect((await call("chat.delete", { channel: ids.channel, ts: reply.ts })).body).toMatchObject({ ok: true, ts: reply.ts });
    await live.next("message.deleted", (e) => e.parentId === parent.id);
    expect((await call("chat.delete", { channel: ids.channel, ts: reply.ts })).body.error).toBe("message_not_found");

    // A DM with a person: D id, im type, the person sees it arrive.
    const dm = (await call("conversations.open", { users: ids.owner })).body;
    expect(dm.channel).toMatchObject({ id: expect.stringMatching(/^D[0-9A-F]{32}$/), is_im: true, user: ids.owner });
    const added = await live.next("channel.added", (e) => e.channel.kind === "dm");
    expect(added.channel.memberIds!.sort()).toEqual([app.botUserId, owner.id].sort());
    expect((await call("conversations.open", { users: ids.owner })).body).toMatchObject({ already_open: true, channel: { id: dm.channel.id } });
    expect((await call("chat.postMessage", { channel: dm.channel.id, text: "안녕하세요" })).body.ok).toBe(true);
    // Posting to a user id goes to the same DM.
    expect((await call("chat.postMessage", { channel: ids.owner, text: "또" })).body.channel).toBe(dm.channel.id);

    const ephemeral = await call("chat.postEphemeral", { channel: ids.channel, user: ids.owner, text: "나만 보기" });
    expect(ephemeral.body).toMatchObject({ ok: true, message_ts: expect.any(String) });
    expect((await live.next("ephemeral")).message).toMatchObject({ channelId: channel.id, text: "나만 보기", author: { id: app.botUserId } });

    const channels = (await call("users.conversations", { types: "public_channel,private_channel,im,mpim" })).body.channels.map((c: any) => c.id);
    expect(channels).toEqual(expect.arrayContaining([ids.channel, dm.channel.id]));
    expect((await call("conversations.history", { channel: slackId("C", (await owner.call<Channel>("POST", ws(w.id, "/channels"), { name: uniqueName() })).body.id) })).body.error).toBe(
      "not_in_channel",
    );
    live.ws.close();
  });
});

describe("Socket Mode", () => {
  it("hands out single-use connections for the app-level token only", async () => {
    const ctx = await setup({ socketMode: true });
    expect((await ctx.call("apps.connections.open")).body).toEqual({ ok: false, error: "invalid_auth" });
    const { client, url, appToken } = await openSocket(ctx);
    expect(client.hello).toMatchObject({ type: "hello", num_connections: 1, connection_info: { app_id: slackId("A", ctx.app.id) } });

    // The ticket was spent.
    const reused = new WebSocket(url);
    await expect(new Promise((resolve, reject) => (reused.on("open", resolve), reused.on("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))))))).rejects.toThrow("401");

    // Turning Socket Mode off closes connections and refuses new ones.
    await ctx.configure({ socketMode: false });
    expect(await client.next((f) => f.type === "disconnect")).toEqual({ type: "disconnect", reason: "link_disabled" });
    await client.closed;
    expect((await slack(appToken)("apps.connections.open")).body).toEqual({ ok: false, error: "not_allowed_token_type" });
  });

  it("delivers message and mention events in Slack's shape to a connection on another node", async () => {
    const ctx = await setup({ socketMode: true });
    const { client } = await openSocket(ctx); // connected to node 0
    const person = await signIn(other(), "person");
    const invite = (await ctx.owner.call<{ url: string }>("POST", ws(ctx.w.id, "/invites"), { role: "member" })).body;
    expect((await person.call("POST", `/api/invites/${invite.url.split("/invite/")[1]}/accept`)).status).toBe(200);
    await ctx.owner.call("POST", `/api/channels/${ctx.channel.id}/members`, { userIds: [person.id] });

    const sent = (await post(person, ctx.channel.id, `<@${ctx.app.botUserId}> 도와줘 & 고마워`, {}, other())).body;
    const mention = await client.next((f) => f.type === "events_api" && f.payload.event.type === "app_mention");
    const message = await client.next((f) => f.type === "events_api" && f.payload.event.type === "message");
    expect(mention).toMatchObject({ accepts_response_payload: false, retry_attempt: 0 });
    expect(mention.payload).toMatchObject({
      type: "event_callback",
      team_id: ctx.ids.team,
      api_app_id: slackId("A", ctx.app.id),
      authorizations: [{ team_id: ctx.ids.team, user_id: ctx.ids.bot, is_bot: true }],
      event_id: expect.stringMatching(/^Ev/),
    });
    expect(message.payload.event).toMatchObject({
      type: "message",
      channel: ctx.ids.channel,
      channel_type: "channel",
      user: slackId("U", person.id),
      text: `<@${ctx.ids.bot}> 도와줘 &amp; 고마워`,
      client_msg_id: sent.clientMsgId,
      team: ctx.ids.team,
    });
    expect(mention.payload.event.ts).toBe(message.payload.event.ts);
    expect(mention.payload.event.channel_type).toBeUndefined();
    client.ack(mention);
    client.ack(message);

    // The bot's own posts raise no events for it.
    await ctx.call("chat.postMessage", { channel: ctx.ids.channel, text: "네", thread_ts: message.payload.event.ts });
    await expect(client.next((f) => f.type === "events_api", 400)).rejects.toThrow("timed out");

    // DMs arrive as im.
    const dm = (await ctx.call("conversations.open", { users: slackId("U", person.id) })).body.channel;
    await post(person, fromSlack(dm.id), "DM 질문", {}, other());
    const im = await client.next((f) => f.type === "events_api");
    expect(im.payload.event).toMatchObject({ channel: dm.id, channel_type: "im", text: "DM 질문" });
    client.ack(im);
    client.socket.close();
  });

  it("runs slash commands with the reply in the acknowledgement, and button clicks with response URLs", async () => {
    const ctx = await setup({ socketMode: true });
    expect((await ctx.owner.call("POST", ws(ctx.w.id, `/apps/${ctx.app.id}/commands`), { command: "hermes" })).status).toBe(201);
    const live = connect(base(), ctx.owner.cookie);
    await live.ready();

    // Not connected: the person is told so.
    expect((await ctx.owner.call("POST", `/api/channels/${ctx.channel.id}/commands`, { command: "hermes", text: "status" })).status).toBe(204);
    expect((await live.next("ephemeral", () => true, 5000)).message.text).toContain("연결되어 있지 않거나");

    const { client } = await openSocket(ctx);
    const run = ctx.owner.call("POST", `/api/channels/${ctx.channel.id}/commands`, { command: "hermes", text: "status" }, other());
    const envelope = await client.next((f) => f.type === "slash_commands");
    expect(envelope.accepts_response_payload).toBe(true);
    expect(envelope.payload).toMatchObject({
      command: "/hermes",
      text: "status",
      channel_id: ctx.ids.channel,
      user_id: ctx.ids.owner,
      team_id: ctx.ids.team,
      response_url: expect.stringContaining("/api/slack/response/"),
    });
    client.ack(envelope, { text: "*정상* 동작 중", response_type: "in_channel" });
    expect((await run).status).toBe(204);
    expect((await live.next("message.created")).message).toMatchObject({ text: "*정상* 동작 중", author: { id: ctx.app.botUserId } });

    // A late ephemeral reply through the Slack-shaped response URL.
    const late = await fetch(envelope.payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "나중에 답" }) });
    expect(late.status).toBe(200);
    expect((await live.next("ephemeral")).message.text).toBe("나중에 답");

    // Buttons the app posted in Block Kit come back as block_actions.
    const posted = (
      await ctx.call("chat.postMessage", {
        channel: ctx.ids.channel,
        text: "승인할까요?",
        blocks: [{ type: "actions", elements: [{ type: "button", action_id: "hermes_approve", text: { type: "plain_text", text: "승인" }, value: "yes" }] }],
      })
    ).body;
    const withButton = await live.next("message.created", (e) => e.message.text === "승인할까요?");
    const click = ctx.owner.call("POST", `/api/messages/${withButton.message.id}/actions`, { actionId: "hermes_approve", value: "yes" }, other());
    const action = await client.next((f) => f.type === "interactive");
    expect(action.payload).toMatchObject({
      type: "block_actions",
      user: { id: ctx.ids.owner },
      container: { message_ts: posted.ts, channel_id: ctx.ids.channel },
      message: { ts: posted.ts, blocks: [{ type: "actions", block_id: "b0" }] },
      actions: [{ action_id: "hermes_approve", block_id: "b0", value: "yes", text: { type: "plain_text", text: "승인" } }],
    });
    client.ack(action);
    expect((await click).status).toBe(204);
    await fetch(action.payload.response_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_original: true, text: "승인됨", blocks: [{ type: "section", text: { type: "mrkdwn", text: "✅ 승인됨" } }] }),
    });
    expect((await live.next("message.updated", (e) => e.message.id === withButton.message.id)).message).toMatchObject({ text: "승인됨", blocks: [{ type: "section", text: "✅ 승인됨" }], editedAt: null });
    await fetch(action.payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete_original: true }) });
    await live.next("message.deleted", (e) => e.id === withButton.message.id);
    client.socket.close();
    live.ws.close();
  });

  it("requires a command URL only for apps not in Socket Mode", async () => {
    const ctx = await setup();
    expect((await ctx.owner.call("POST", ws(ctx.w.id, `/apps/${ctx.app.id}/commands`), { command: "x" })).body).toEqual({ error: "command_url_required" });
  });

  it("reissuing the app-level token closes open connections", async () => {
    const ctx = await setup({ socketMode: true });
    const { client, appToken } = await openSocket(ctx);
    await ctx.owner.call("POST", ws(ctx.w.id, `/apps/${ctx.app.id}/app-token`));
    expect((await client.next((f) => f.type === "disconnect")).reason).toBe("link_disabled");
    expect((await slack(appToken)("apps.connections.open")).body.error).toBe("invalid_auth");
  });
});

const fromSlack = (id: string) => {
  const hex = id.slice(1).toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
