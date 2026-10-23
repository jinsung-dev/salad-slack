import { describe, expect, it } from "vitest";
import type { Channel, Message, MessagePage } from "@chatter/shared";
import { signIn, uniqueName, useCluster, type Client } from "./helpers";

const { urls } = useCluster();
const base = () => urls[0]!;

const post = async (who: Client, channelId: string, text: string, extra: Record<string, unknown> = {}) =>
  (await who.call<Message>("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: crypto.randomUUID(), ...extra })).body;
const search = async (who: Client, params: Record<string, string>) =>
  (await who.call<MessagePage>("GET", `/api/search?${new URLSearchParams(params)}`)).body;
const texts = (page: MessagePage) => page.messages.map((m) => m.text);

describe("message search", () => {
  it("finds partial Korean words, newest first, in every conversation the viewer can read", async () => {
    const [alice, bob] = [await signIn(base(), "alice"), await signIn(base(), "bob")];
    const open = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const secret = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName(), isPrivate: true })).body;
    const tag = crypto.randomUUID().slice(0, 6);

    const first = await post(alice, open.id, `${tag} 배포 일정 공유합니다`);
    await post(alice, open.id, `${tag} 점심 메뉴`);
    const reply = await post(alice, open.id, `${tag} 배포는 금요일`, { parentId: first.id });
    await post(alice, secret.id, `${tag} 비공개 배포 메모`);

    expect(texts(await search(alice, { q: `${tag} 배포` }))).toEqual([
      `${tag} 비공개 배포 메모`,
      `${tag} 배포는 금요일`,
      `${tag} 배포 일정 공유합니다`,
    ]);
    // Bob is not in the private channel; thread replies are included with their parent.
    const forBob = await search(bob, { q: `${tag} 배포` });
    expect(texts(forBob)).toEqual([`${tag} 배포는 금요일`, `${tag} 배포 일정 공유합니다`]);
    expect(forBob.messages[0]!.parentId).toBe(reply.parentId);
  });

  it("filters by channel, author and time, pages with a cursor, and treats wildcards literally", async () => {
    const [alice, bob] = [await signIn(base(), "alice"), await signIn(base(), "bob")];
    const a = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const b = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    await bob.call("POST", `/api/channels/${a.id}/join`);
    const tag = crypto.randomUUID().slice(0, 6);
    await post(alice, a.id, `${tag} one`);
    await post(bob, a.id, `${tag} two`);
    await post(alice, b.id, `${tag} three`);
    await post(alice, b.id, `${tag} 100%_done`);

    expect(texts(await search(alice, { q: tag, channelId: b.id }))).toEqual([`${tag} 100%_done`, `${tag} three`]);
    expect(texts(await search(alice, { q: tag, authorId: bob.id }))).toEqual([`${tag} two`]);
    expect(texts(await search(alice, { q: `${tag} %_` }))).toEqual([`${tag} 100%_done`]);
    expect(texts(await search(alice, { q: tag, to: new Date(Date.now() - 60_000).toISOString() }))).toEqual([]);

    const page1 = await search(alice, { q: tag, limit: "3" });
    expect(page1.hasMore).toBe(true);
    const page2 = await search(alice, { q: tag, limit: "3", before: String(page1.messages.at(-1)!.id) });
    expect([...texts(page1), ...texts(page2)]).toEqual([`${tag} 100%_done`, `${tag} three`, `${tag} two`, `${tag} one`]);
    expect(page2.hasMore).toBe(false);
  });

  it("skips deleted messages and rejects empty queries", async () => {
    const alice = await signIn(base(), "alice");
    const c = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName() })).body;
    const tag = crypto.randomUUID().slice(0, 6);
    const gone = await post(alice, c.id, `${tag} oops`);
    await alice.call("DELETE", `/api/messages/${gone.id}`);
    expect(texts(await search(alice, { q: tag }))).toEqual([]);
    expect((await alice.call("GET", "/api/search?q=%20")).status).toBe(400);
  });
});

describe("saved messages", () => {
  it("keeps a personal list, newest save first, without deleted messages, for readers only", async () => {
    const [alice, bob] = [await signIn(base(), "alice"), await signIn(base(), "bob")];
    const room = (await alice.call<Channel>("POST", "/api/channels", { name: uniqueName(), isPrivate: true })).body;
    await alice.call("POST", `/api/channels/${room.id}/members`, { userIds: [bob.id] });
    const [one, two, three] = [await post(alice, room.id, "one"), await post(alice, room.id, "two"), await post(alice, room.id, "three")];

    for (const m of [two, one, three]) expect((await bob.call("PUT", `/api/messages/${m.id}/save`)).status).toBe(204);
    await bob.call("PUT", `/api/messages/${one.id}/save`); // idempotent
    const saved = async (who: Client) => texts((await who.call<MessagePage>("GET", "/api/saved")).body);
    expect(await saved(bob)).toEqual(["three", "one", "two"]);
    expect(await saved(alice)).toEqual([]);

    await bob.call("DELETE", `/api/messages/${one.id}/save`);
    await alice.call("DELETE", `/api/messages/${two.id}`);
    expect(await saved(bob)).toEqual(["three"]);

    const outsider = await signIn(base(), "carol");
    expect((await outsider.call("PUT", `/api/messages/${three.id}/save`)).status).toBe(404);
  });
});
