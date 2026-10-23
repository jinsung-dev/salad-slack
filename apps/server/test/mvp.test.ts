import { describe, expect, it } from "vitest";
import type { Channel, Message, MessagePage } from "@chatter/shared";
import { connect, signIn, uniqueName, useCluster } from "./helpers";

const { urls } = useCluster();
const base = () => urls[0]!;

describe("MVP chat workflow", () => {
  it("signs up, reports the session user, and logs out", async () => {
    const alice = await signIn(base(), "alice");
    expect((await alice.call("GET", "/api/auth/me")).body).toMatchObject({ id: alice.id, displayName: "alice" });
    expect((await alice.call("POST", "/api/auth/logout")).status).toBe(204);
    expect((await alice.call("GET", "/api/auth/me")).status).toBe(401);
  });

  it("rejects unauthenticated API and WebSocket access", async () => {
    expect((await fetch(`${base()}/api/channels`)).status).toBe(401);
    const { ws } = connect(base());
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode!)));
    expect(status).toBe(401);
  });

  it("creates channels with unique normalized names", async () => {
    const alice = await signIn(base(), "alice");
    const name = uniqueName();
    const created = await alice.call("POST", "/api/channels", { name: name.toUpperCase() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, kind: "public", isMember: true, unreadCount: 0, mentionCount: 0 });
    expect((await alice.call("POST", "/api/channels", { name })).status).toBe(409);
    expect((await alice.call("POST", "/api/channels", { name: "bad name!" })).status).toBe(400);
  });

  it("accepts Korean channel names and treats composed and decomposed Hangul as one name", async () => {
    const alice = await signIn(base(), "alice");
    const name = `개발-${uniqueName()}`;
    const created = await alice.call<Channel>("POST", "/api/channels", { name });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe(name);
    expect((await alice.call("POST", "/api/channels", { name: name.normalize("NFD") })).status).toBe(409);
    expect((await alice.call("POST", "/api/channels", { name: "공지 사항" })).status).toBe(400);
  });

  it("delivers messages in realtime to members and tracks unread counts", async () => {
    const alice = await signIn(base(), "alice");
    const bob = await signIn(base(), "bob");
    const channel = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;

    expect((await bob.call("POST", `/api/channels/${channel.id}/messages`, { text: "hi", clientMsgId: "x" })).status).toBe(403);
    expect((await bob.call("POST", `/api/channels/${channel.id}/join`)).status).toBe(204);

    const bobSocket = connect(base(), bob.cookie);
    await bobSocket.ready();

    const sent = await alice.call<Message>("POST", `/api/channels/${channel.id}/messages`, { text: "hello *bob*", clientMsgId: "m1" });
    expect(sent.status).toBe(201);
    const event = await bobSocket.next("message.created");
    expect(event.message).toMatchObject({ id: sent.body.id, text: "hello *bob*", author: { displayName: "alice" } });

    const unread = async (who: typeof bob) =>
      (await who.call<Channel[]>("GET", "/api/channels")).body.find((c) => c.id === channel.id)!.unreadCount;
    expect(await unread(bob)).toBe(1);
    expect(await unread(alice)).toBe(0); // own messages are never unread

    expect((await bob.call("POST", `/api/channels/${channel.id}/read`, { messageId: sent.body.id })).status).toBe(204);
    expect(await unread(bob)).toBe(0);
    bobSocket.ws.close();
  });

  it("treats a retried send with the same clientMsgId as the original", async () => {
    const alice = await signIn(base(), "alice");
    const channel = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const first = await alice.call<Message>("POST", `/api/channels/${channel.id}/messages`, { text: "once", clientMsgId: "retry" });
    const second = await alice.call<Message>("POST", `/api/channels/${channel.id}/messages`, { text: "once", clientMsgId: "retry" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const page = (await alice.call<MessagePage>("GET", `/api/channels/${channel.id}/messages`)).body;
    expect(page.messages).toHaveLength(1);
  });

  it("pages history backwards with a before cursor", async () => {
    const alice = await signIn(base(), "alice");
    const channel = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    for (let i = 1; i <= 5; i++) {
      await alice.call("POST", `/api/channels/${channel.id}/messages`, { text: `m${i}`, clientMsgId: `p${i}` });
    }
    const newest = (await alice.call<MessagePage>("GET", `/api/channels/${channel.id}/messages?limit=2`)).body;
    expect(newest.messages.map((m) => m.text)).toEqual(["m4", "m5"]);
    expect(newest.hasMore).toBe(true);
    const older = (await alice.call<MessagePage>("GET", `/api/channels/${channel.id}/messages?limit=10&before=${newest.messages[0]!.id}`))
      .body;
    expect(older.messages.map((m) => m.text)).toEqual(["m1", "m2", "m3"]);
    expect(older.hasMore).toBe(false);
  });

  it("marks existing history as read when joining", async () => {
    const alice = await signIn(base(), "alice");
    const carol = await signIn(base(), "carol");
    const channel = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    await alice.call("POST", `/api/channels/${channel.id}/messages`, { text: "before join", clientMsgId: "b1" });
    await carol.call("POST", `/api/channels/${channel.id}/join`);
    const list = (await carol.call<Channel[]>("GET", "/api/channels")).body;
    expect(list.find((c) => c.id === channel.id)).toMatchObject({ isMember: true, unreadCount: 0 });
  });
});
