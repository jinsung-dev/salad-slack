import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { CHANNEL_MENTION, mentionToken, type Channel, type Message, type Preferences } from "@chatter/shared";
import { pushSubscriptions } from "../src/db/schema";
import { inQuietHours, pushPayload, wantsNotification, type PushPayload, type PushTarget } from "../src/notify";
import { connect, signIn, uniqueName, useCluster, type Client, useWorkspace } from "./helpers";

// A push service stand-in: records deliveries; endpoints ending in "/gone" report an expired subscription.
const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const send = async (target: PushTarget, payload: string) => {
  sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
  return { gone: target.endpoint.endsWith("/gone") };
};
const { urls, db } = useCluster(1, { push: { publicKey: "test-public-key", send } });
const base = () => urls[0]!;
const home = useWorkspace(base);

const msg = (over: Partial<Message> = {}): Message => ({
  id: 1, channelId: "c", parentId: null, author: { id: "author", displayName: "Kim" }, text: "hi", clientMsgId: "k",
  createdAt: "", editedAt: null, deleted: false, alsoSentToChannel: false, mentions: [], mentionsChannel: false,
  reactions: [], files: [], blocks: null, thread: null, ...over,
});

describe("notification rules", () => {
  it("decides by level, mentions and thread ownership", () => {
    const r = (level: "all" | "mentions" | "none", ownsThread = false) => ({ userId: "me", level, ownsThread });
    expect(wantsNotification(msg(), r("all"))).toBe(true);
    expect(wantsNotification(msg(), r("mentions"))).toBe(false);
    expect(wantsNotification(msg({ mentions: ["me"] }), r("mentions"))).toBe(true);
    expect(wantsNotification(msg({ mentionsChannel: true }), r("mentions"))).toBe(true);
    expect(wantsNotification(msg({ mentions: ["me"] }), r("none"))).toBe(false);
    expect(wantsNotification(msg({ author: { id: "me", displayName: "me" } }), r("all"))).toBe(false);
    // Thread replies: only mentions or your own thread, whatever the level.
    expect(wantsNotification(msg({ parentId: 9 }), r("all"))).toBe(false);
    expect(wantsNotification(msg({ parentId: 9 }), r("mentions", true))).toBe(true);
    expect(wantsNotification(msg({ parentId: 9, alsoSentToChannel: true }), r("all"))).toBe(true);
  });

  it("applies quiet hours in the person's own time zone, across midnight", () => {
    const night = { enabled: true, start: 22 * 60, end: 8 * 60, timeZone: "Asia/Seoul" };
    expect(inQuietHours(night, new Date("2026-10-23T14:30:00Z"))).toBe(true); // 23:30 KST
    expect(inQuietHours(night, new Date("2026-10-23T22:59:00Z"))).toBe(true); // 07:59 KST
    expect(inQuietHours(night, new Date("2026-10-23T23:00:00Z"))).toBe(false); // 08:00 KST
    expect(inQuietHours({ ...night, timeZone: "Europe/London" }, new Date("2026-10-23T14:30:00Z"))).toBe(false);
    expect(inQuietHours({ ...night, enabled: false }, new Date("2026-10-23T14:30:00Z"))).toBe(false);
    expect(inQuietHours({ ...night, start: 9 * 60, end: 18 * 60 }, new Date("2026-10-23T03:00:00Z"))).toBe(true); // 12:00 KST
  });

  it("writes readable previews", () => {
    const names = new Map([["11111111-1111-4111-8111-111111111111", "Lee"]]);
    const text = `${mentionToken("11111111-1111-4111-8111-111111111111")} ${CHANNEL_MENTION}\n확인   부탁 ${"가".repeat(200)}`;
    const p = pushPayload(msg({ id: 7, text }), { workspaceId: "w", kind: "public", name: "dev" }, names);
    expect(p.title).toBe("#dev");
    expect(p.body.startsWith("Kim: @Lee @channel 확인 부탁 가")).toBe(true);
    expect(p.body.length).toBe("Kim: ".length + 140);
    expect(p).toMatchObject({ url: "/w/w/c/c", tag: "message-7" });
    const dm = pushPayload(msg({ text: "", files: [{ id: "f", name: "a", mimeType: "x/y", size: 1, url: "", inline: false }] }), { workspaceId: "w", kind: "dm", name: null }, names);
    expect(dm).toMatchObject({ title: "Kim", body: "파일 1개" });
    expect(pushPayload(msg({ parentId: 3 }), { workspaceId: "w", kind: "public", name: "dev" }, names)).toMatchObject({ title: "#dev 스레드", url: "/w/w/c/c/t/3" });
  });
});

describe("push delivery", () => {
  const subscribe = (who: Client, suffix = "") =>
    who.call("POST", "/api/push/subscriptions", { endpoint: `https://push.test/${who.id}${suffix}`, keys: { p256dh: "p", auth: "a" } });
  const post = async (who: Client, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
    (await who.call<Message>("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: crypto.randomUUID(), ...extra })).body;
  /** Deliveries to `who` for a message, waiting briefly since push runs off the request path. */
  const pushesFor = async (who: Client, messageId: number, settleMs = 300) => {
    await new Promise((r) => setTimeout(r, settleMs));
    return sent.filter((s) => s.endpoint.includes(who.id) && s.payload.tag === `message-${messageId}`);
  };

  async function setup() {
    const [alice, bob] = [await home.member("alice"), await home.member("bob")];
    const channel = (await alice.call<Channel>("POST", home.path("/channels"), { name: uniqueName() })).body;
    await bob.call("POST", `/api/channels/${channel.id}/join`);
    await subscribe(bob);
    return { alice, bob, channel };
  }

  it("follows the member's level: mentions by default in channels, everything in DMs", async () => {
    const { alice, bob, channel } = await setup();
    expect((await bob.call<Channel[]>("GET", home.path("/channels"))).body.find((c) => c.id === channel.id)!.notify).toBe("mentions");
    expect(await pushesFor(bob, (await post(alice, channel.id, "plain")).id)).toHaveLength(0);
    const mention = await post(alice, channel.id, `hey ${mentionToken(bob.id)}`);
    expect((await pushesFor(bob, mention.id))[0]!.payload).toMatchObject({ title: `#${channel.name}`, body: "alice: hey @bob" });

    expect((await bob.call("PUT", `/api/channels/${channel.id}/notify`, { level: "all" })).status).toBe(204);
    expect(await pushesFor(bob, (await post(alice, channel.id, "now everything")).id)).toHaveLength(1);
    await bob.call("PUT", `/api/channels/${channel.id}/notify`, { level: "none" });
    expect(await pushesFor(bob, (await post(alice, channel.id, `muted ${mentionToken(bob.id)}`)).id)).toHaveLength(0);

    const dm = (await alice.call<Channel>("POST", home.path("/dms"), { userIds: [bob.id] })).body;
    expect(dm.notify).toBe("all");
    expect((await pushesFor(bob, (await post(alice, dm.id, "psst")).id))[0]!.payload).toMatchObject({ title: "alice", body: "psst" });
  });

  it("skips people looking at Chatter and people in quiet hours", async () => {
    const { alice, bob, channel } = await setup();
    const tab = connect(base(), bob.cookie);
    await tab.ready();
    tab.send({ type: "focus", focused: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(await pushesFor(bob, (await post(alice, channel.id, `look ${mentionToken(bob.id)}`)).id)).toHaveLength(0);
    tab.send({ type: "focus", focused: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(await pushesFor(bob, (await post(alice, channel.id, `away ${mentionToken(bob.id)}`)).id)).toHaveLength(1);
    tab.ws.close();

    // An hour either side of now in Seoul, so it never depends on when the test runs.
    const kst = (offsetMin: number) =>
      new Date(Date.now() + offsetMin * 60_000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const always: Preferences = { timeZone: "Asia/Seoul", quietHours: { enabled: true, start: kst(-60), end: kst(60) } };
    expect((await bob.call("PUT", "/api/me/preferences", always)).status).toBe(204);
    expect((await bob.call<Preferences>("GET", "/api/me/preferences")).body).toEqual(always);
    expect(await pushesFor(bob, (await post(alice, channel.id, `night ${mentionToken(bob.id)}`)).id)).toHaveLength(0);
    expect((await bob.call("PUT", "/api/me/preferences", { ...always, timeZone: "Mars/Olympus" })).status).toBe(400);
  });

  it("tells a thread's author about replies and drops expired subscriptions", async () => {
    const { alice, bob, channel } = await setup();
    const topic = await post(bob, channel.id, "question");
    expect(await pushesFor(bob, (await post(alice, channel.id, "answer", { parentId: topic.id })).id)).toHaveLength(1);

    await subscribe(bob, "/gone");
    const next = await post(alice, channel.id, `ping ${mentionToken(bob.id)}`);
    expect(await pushesFor(bob, next.id)).toHaveLength(2);
    const left = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, bob.id));
    expect(left.map((s) => s.endpoint)).toEqual([`https://push.test/${bob.id}`]);
  });

  it("exposes the public key and keeps notification levels to members", async () => {
    const { alice, channel } = await setup();
    expect((await alice.call("GET", "/api/push/key")).body).toEqual({ publicKey: "test-public-key" });
    const outsider = await home.member("carol");
    expect((await outsider.call("PUT", `/api/channels/${channel.id}/notify`, { level: "all" })).status).toBe(403);
  });
});
