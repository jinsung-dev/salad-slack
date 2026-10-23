import { describe, expect, it } from "vitest";
import { CHANNEL_MENTION, mentionToken, type Channel, type Message, type MessagePage, type PresenceMap } from "@chatter/shared";
import { connect, signIn, uniqueName, useCluster, type Client } from "./helpers";

// Two nodes: users talk to node A, realtime listeners sit on node B unless noted,
// so every delivery below crosses the Redis bus.
const { urls } = useCluster(2);
const nodeA = () => urls[0]!;
const nodeB = () => urls[1]!;

const channelOf = async (who: Client, id: string) => (await who.call<Channel[]>("GET", "/api/channels")).body.find((c) => c.id === id);
const post = (who: Client, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  who.call<Message>("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: crypto.randomUUID(), ...extra });

async function team<const N extends readonly string[]>(...names: N) {
  return (await Promise.all(names.map((n) => signIn(nodeA(), n)))) as { -readonly [K in keyof N]: Client };
}

async function publicChannel(owner: Client, ...members: Client[]) {
  const channel = (await owner.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
  for (const m of members) await m.call("POST", `/api/channels/${channel.id}/join`);
  return channel;
}

describe("cluster delivery", () => {
  it("delivers a message posted on one node to a socket on another", async () => {
    const [alice, bob] = await team("alice", "bob");
    const channel = await publicChannel(alice, bob);
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();
    const sent = await post(alice, channel.id, "across nodes");
    expect((await bobSocket.next("message.created")).message.id).toBe(sent.body.id);
    bobSocket.ws.close();
  });

  it("announces new members to everyone's directory", async () => {
    const [alice] = await team("alice");
    const aliceSocket = connect(nodeB(), alice.cookie);
    await aliceSocket.ready();
    const [dana] = await team("dana");
    expect(await aliceSocket.next("member.joined", (e) => e.member.id === dana.id)).toMatchObject({ member: { displayName: "dana" } });
    aliceSocket.ws.close();
  });
});

describe("private channels", () => {
  it("are invisible to non-members until invited", async () => {
    const [alice, bob] = await team("alice", "bob");
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();

    const created = await alice.call<Channel>("POST", "/api/channels", { name: uniqueName(), isPrivate: true });
    expect(created.body).toMatchObject({ kind: "private", isMember: true });
    const id = created.body.id;
    await post(alice, id, "secret");

    await bobSocket.none("channel.added", (e) => e.channel.id === id);
    expect(await channelOf(bob, id)).toBeUndefined();
    expect((await bob.call("GET", `/api/channels/${id}/messages`)).status).toBe(404);
    expect((await bob.call("POST", `/api/channels/${id}/join`)).status).toBe(404);
    expect((await post(bob, id, "let me in")).status).toBe(404);

    expect((await alice.call("POST", `/api/channels/${id}/members`, { userIds: [bob.id] })).status).toBe(204);
    expect(await bobSocket.next("channel.added", (e) => e.channel.id === id)).toMatchObject({ isMember: true });
    // Joining shows existing history as read.
    expect(await channelOf(bob, id)).toMatchObject({ isMember: true, unreadCount: 0 });
    expect((await bob.call<MessagePage>("GET", `/api/channels/${id}/messages`)).body.messages).toHaveLength(1);
    bobSocket.ws.close();
  });

  it("announces public channels to everyone with their own membership", async () => {
    const [alice, bob] = await team("alice", "bob");
    const [aliceSocket, bobSocket] = [connect(nodeB(), alice.cookie), connect(nodeB(), bob.cookie)];
    await Promise.all([aliceSocket.ready(), bobSocket.ready()]);
    const channel = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    expect(await aliceSocket.next("channel.added", (e) => e.channel.id === channel.id)).toMatchObject({ isMember: true });
    expect(await bobSocket.next("channel.added", (e) => e.channel.id === channel.id)).toMatchObject({ isMember: false });
    aliceSocket.ws.close();
    bobSocket.ws.close();
  });
});

describe("direct messages", () => {
  it("maps one set of people to one conversation", async () => {
    const [alice, bob, carol] = await team("alice", "bob", "carol");
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();

    const first = await alice.call<Channel>("POST", "/api/dms", { userIds: [bob.id] });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ kind: "dm", name: null, isMember: true, memberIds: [alice.id, bob.id].sort() });
    expect((await bobSocket.next("channel.added", (e) => e.channel.id === first.body.id)).isMember).toBe(true);

    const again = await bob.call<Channel>("POST", "/api/dms", { userIds: [alice.id, bob.id] });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const group = await alice.call<Channel>("POST", "/api/dms", { userIds: [bob.id, carol.id] });
    expect(group.body.id).not.toBe(first.body.id);
    expect(group.body.memberIds).toHaveLength(3);
    expect(await channelOf(carol, first.body.id)).toBeUndefined();
    expect((await alice.call("POST", `/api/channels/${first.body.id}/members`, { userIds: [carol.id] })).status).toBe(400);

    const tooMany = Array.from({ length: 8 }, () => crypto.randomUUID());
    expect((await alice.call("POST", "/api/dms", { userIds: tooMany })).status).toBe(400);
    bobSocket.ws.close();
  });
});

describe("threads", () => {
  it("keeps replies out of the channel unless also sent there", async () => {
    const [alice, bob] = await team("alice", "bob");
    const channel = await publicChannel(alice, bob);
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();

    const parent = (await post(alice, channel.id, "question?")).body;
    const reply = await post(alice, channel.id, "answer", { parentId: parent.id });
    expect(reply.status).toBe(201);
    expect(reply.body.parentId).toBe(parent.id);

    const updated = await bobSocket.next("message.updated", (e) => e.message.id === parent.id);
    expect(updated.message.thread).toMatchObject({ replyCount: 1, participantIds: [alice.id] });

    const history = (await bob.call<MessagePage>("GET", `/api/channels/${channel.id}/messages`)).body;
    expect(history.messages.map((m) => m.text)).toEqual(["question?"]);
    expect(await channelOf(bob, channel.id)).toMatchObject({ unreadCount: 1 });

    await post(alice, channel.id, "answer for all", { parentId: parent.id, alsoSendToChannel: true });
    expect(await channelOf(bob, channel.id)).toMatchObject({ unreadCount: 2 });
    const replies = (await bob.call<MessagePage>("GET", `/api/messages/${parent.id}/replies`)).body;
    expect(replies.messages.map((m) => m.text)).toEqual(["answer", "answer for all"]);

    expect((await post(alice, channel.id, "nested", { parentId: reply.body.id })).status).toBe(400);
    expect((await post(alice, channel.id, "loose", { alsoSendToChannel: true })).status).toBe(400);
    bobSocket.ws.close();
  });
});

describe("mentions", () => {
  it("counts mentions of members separately from unread", async () => {
    const [alice, bob, carol] = await team("alice", "bob", "carol");
    const channel = await publicChannel(alice, bob);

    await post(alice, channel.id, `hey ${mentionToken(bob.id)} and ${mentionToken(carol.id)}`);
    await post(alice, channel.id, "no mention");
    expect(await channelOf(bob, channel.id)).toMatchObject({ unreadCount: 2, mentionCount: 1 });
    // Carol is not a member, so she is not notified.
    expect(await channelOf(carol, channel.id)).toMatchObject({ mentionCount: 0 });

    const everyone = (await post(bob, channel.id, `${CHANNEL_MENTION} standup`)).body;
    expect(everyone).toMatchObject({ mentionsChannel: true });
    expect(await channelOf(alice, channel.id)).toMatchObject({ mentionCount: 1 });
    expect(await channelOf(bob, channel.id)).toMatchObject({ mentionCount: 1 }); // not by their own @channel
  });

  it("clears channel mentions on channel read and thread mentions on thread read", async () => {
    const [alice, bob] = await team("alice", "bob");
    const channel = await publicChannel(alice, bob);
    const parent = (await post(alice, channel.id, `look ${mentionToken(bob.id)}`)).body;
    const reply = (await post(alice, channel.id, `in thread ${mentionToken(bob.id)}`, { parentId: parent.id })).body;
    expect(await channelOf(bob, channel.id)).toMatchObject({ mentionCount: 2 });

    await bob.call("POST", `/api/channels/${channel.id}/read`, { messageId: reply.id });
    expect(await channelOf(bob, channel.id)).toMatchObject({ unreadCount: 0, mentionCount: 1 });

    await bob.call("POST", `/api/messages/${parent.id}/thread/read`);
    expect(await channelOf(bob, channel.id)).toMatchObject({ mentionCount: 0 });
  });
});

describe("editing and deleting", () => {
  it("lets only the author edit, and re-derives mentions", async () => {
    const [alice, bob] = await team("alice", "bob");
    const channel = await publicChannel(alice, bob);
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();
    const msg = (await post(alice, channel.id, `ping ${mentionToken(bob.id)}`)).body;
    expect(await channelOf(bob, channel.id)).toMatchObject({ mentionCount: 1 });

    expect((await bob.call("PATCH", `/api/messages/${msg.id}`, { text: "hijack" })).status).toBe(403);
    const edited = await alice.call<Message>("PATCH", `/api/messages/${msg.id}`, { text: "never mind" });
    expect(edited.body).toMatchObject({ text: "never mind", mentions: [] });
    expect(edited.body.editedAt).not.toBeNull();
    expect((await bobSocket.next("message.updated", (e) => e.message.id === msg.id)).message.text).toBe("never mind");
    expect(await channelOf(bob, channel.id)).toMatchObject({ mentionCount: 0 });
    bobSocket.ws.close();
  });

  it("removes plain messages and keeps a placeholder for threads until they empty", async () => {
    const [alice, bob] = await team("alice", "bob");
    const channel = await publicChannel(alice, bob);
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();
    const history = async () => (await bob.call<MessagePage>("GET", `/api/channels/${channel.id}/messages`)).body.messages;

    const plain = (await post(alice, channel.id, "oops")).body;
    expect((await bob.call("DELETE", `/api/messages/${plain.id}`)).status).toBe(403);
    expect((await alice.call("DELETE", `/api/messages/${plain.id}`)).status).toBe(204);
    expect(await bobSocket.next("message.deleted", (e) => e.id === plain.id)).toMatchObject({ parentId: null });
    expect(await history()).toEqual([]);
    expect(await channelOf(bob, channel.id)).toMatchObject({ unreadCount: 0 });

    const parent = (await post(alice, channel.id, "topic")).body;
    const reply = (await post(bob, channel.id, "reply", { parentId: parent.id })).body;
    await alice.call("DELETE", `/api/messages/${parent.id}`);
    const placeholder = await bobSocket.next("message.updated", (e) => e.message.id === parent.id && e.message.deleted);
    expect(placeholder.message).toMatchObject({ text: "", thread: { replyCount: 1 } });
    expect((await history()).map((m) => m.deleted)).toEqual([true]);

    await bob.call("DELETE", `/api/messages/${reply.id}`);
    await bobSocket.next("message.deleted", (e) => e.id === reply.id);
    await bobSocket.next("message.deleted", (e) => e.id === parent.id);
    expect(await history()).toEqual([]);
    expect((await bob.call("GET", `/api/messages/${parent.id}`)).status).toBe(404);
    bobSocket.ws.close();
  });
});

describe("reactions", () => {
  it("aggregates one reaction per person and emoji", async () => {
    const [alice, bob, carol] = await team("alice", "bob", "carol");
    const channel = await publicChannel(alice, bob);
    const msg = (await post(alice, channel.id, "ship it?")).body;
    const aliceSocket = connect(nodeB(), alice.cookie);
    await aliceSocket.ready();

    const thumbs = encodeURIComponent("👍");
    await bob.call("PUT", `/api/messages/${msg.id}/reactions/${thumbs}`);
    await bob.call("PUT", `/api/messages/${msg.id}/reactions/${thumbs}`);
    const both = await alice.call("PUT", `/api/messages/${msg.id}/reactions/${thumbs}`);
    expect(both.body).toEqual([{ emoji: "👍", userIds: [bob.id, alice.id] }]);
    expect(await aliceSocket.next("reaction.updated", (e) => e.reactions[0]?.userIds.length === 2)).toMatchObject({ messageId: msg.id });

    expect((await carol.call("PUT", `/api/messages/${msg.id}/reactions/${thumbs}`)).status).toBe(403);
    const removed = await bob.call("DELETE", `/api/messages/${msg.id}/reactions/${thumbs}`);
    expect(removed.body).toEqual([{ emoji: "👍", userIds: [alice.id] }]);
    aliceSocket.ws.close();
  });
});

describe("presence and typing", () => {
  it("reports presence across nodes", async () => {
    const [alice, bob] = await team("alice", "bob");
    const aliceSocket = connect(nodeA(), alice.cookie);
    await aliceSocket.ready();
    const presence = async () => (await alice.call<PresenceMap>("GET", "/api/presence")).body[bob.id];

    expect(await presence()).toBeUndefined();
    const bobSocket = connect(nodeB(), bob.cookie);
    await bobSocket.ready();
    await aliceSocket.next("presence.changed", (e) => e.userId === bob.id && e.status === "active");
    expect(await presence()).toBe("active");

    bobSocket.send({ type: "presence", status: "away" });
    await aliceSocket.next("presence.changed", (e) => e.userId === bob.id && e.status === "away");
    expect(await presence()).toBe("away");

    bobSocket.ws.close();
    await aliceSocket.next("presence.changed", (e) => e.userId === bob.id && e.status === "offline");
    expect(await presence()).toBeUndefined();
    aliceSocket.ws.close();
  });

  it("relays typing to other members only", async () => {
    const [alice, bob, carol] = await team("alice", "bob", "carol");
    const channel = await publicChannel(alice, bob);
    const sockets = [alice, bob, carol].map((u) => connect(nodeB(), u.cookie));
    await Promise.all(sockets.map((s) => s.ready()));
    const [aliceSocket, bobSocket, carolSocket] = sockets as [typeof sockets[0], typeof sockets[0], typeof sockets[0]];

    bobSocket.send({ type: "typing", channelId: channel.id, parentId: null });
    expect(await aliceSocket.next("typing")).toMatchObject({ channelId: channel.id, userId: bob.id, parentId: null });
    await carolSocket.none("typing");
    await bobSocket.none("typing");

    // Non-members cannot announce typing.
    carolSocket.send({ type: "typing", channelId: channel.id, parentId: null });
    await aliceSocket.none("typing", (e) => e.userId === carol.id);
    for (const s of sockets) s.ws.close();
  });
});
