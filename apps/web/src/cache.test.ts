import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { Channel, ChannelSummary, Message, MessagePage } from "@chatter/shared";
import { appendMessage, flattenPages, keys, removeMessage, updateMessage, upsertChannel } from "./cache";

const msg = (id: number, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: "c1",
  parentId: null,
  author: { id: "u1", displayName: "u" },
  text: `m${id}`,
  clientMsgId: `k${id}`,
  createdAt: new Date(0).toISOString(),
  editedAt: null,
  deleted: false,
  alsoSentToChannel: false,
  mentions: [],
  mentionsChannel: false,
  reactions: [],
  thread: null,
  ...extra,
});

const seed = (qc: QueryClient, key: readonly unknown[], ...pages: Message[][]) =>
  qc.setQueryData(key, { pages: pages.map((messages, i) => ({ messages, hasMore: i < pages.length - 1 }) satisfies MessagePage), pageParams: [] });

const ids = (qc: QueryClient, key: readonly unknown[]) => flattenPages(qc.getQueryData(key)).map((m) => m.id);

describe("message cache", () => {
  it("appends once even when the REST response and realtime event both arrive", () => {
    const qc = new QueryClient();
    seed(qc, keys.messages("c1"), [msg(3), msg(4)], [msg(1), msg(2)]);
    appendMessage(qc, msg(5));
    appendMessage(qc, msg(5));
    expect(ids(qc, keys.messages("c1"))).toEqual([1, 2, 3, 4, 5]);
  });

  it("routes thread replies to their thread, and to the channel only when also sent there", () => {
    const qc = new QueryClient();
    seed(qc, keys.messages("c1"), [msg(1)]);
    seed(qc, keys.thread(1), []);
    appendMessage(qc, msg(2, { parentId: 1 }));
    appendMessage(qc, msg(3, { parentId: 1, alsoSentToChannel: true }));
    expect(ids(qc, keys.messages("c1"))).toEqual([1, 3]);
    expect(ids(qc, keys.thread(1))).toEqual([2, 3]);
  });

  it("updates and removes a message everywhere it is cached", () => {
    const qc = new QueryClient();
    seed(qc, keys.messages("c1"), [msg(1), msg(3, { parentId: 1, alsoSentToChannel: true })]);
    seed(qc, keys.thread(1), [msg(3, { parentId: 1, alsoSentToChannel: true })]);
    updateMessage(qc, "c1", 3, (m) => ({ ...m, text: "edited" }));
    expect(flattenPages(qc.getQueryData(keys.thread(1)))[0]!.text).toBe("edited");
    expect(flattenPages(qc.getQueryData(keys.messages("c1")))[1]!.text).toBe("edited");
    removeMessage(qc, "c1", 3);
    expect(ids(qc, keys.messages("c1"))).toEqual([1]);
    expect(ids(qc, keys.thread(1))).toEqual([]);
  });
});

describe("channel cache", () => {
  const summary: ChannelSummary = { id: "c1", kind: "public", name: "general", topic: "", memberIds: null };
  const created: Channel = { ...summary, isMember: true, unreadCount: 0, mentionCount: 0 };

  it("keeps the creator's membership whichever of the event and the response arrives first", () => {
    for (const apply of [
      (qc: QueryClient) => (upsertChannel(qc, summary, true), upsertChannel(qc, created)),
      (qc: QueryClient) => (upsertChannel(qc, created), upsertChannel(qc, summary, true)),
    ]) {
      const qc = new QueryClient();
      qc.setQueryData<Channel[]>(keys.channels, []);
      apply(qc);
      expect(qc.getQueryData<Channel[]>(keys.channels)).toEqual([created]);
    }
  });

  it("keeps known unread counts when an event only changes membership", () => {
    const qc = new QueryClient();
    qc.setQueryData<Channel[]>(keys.channels, [{ ...created, isMember: false, unreadCount: 3 }]);
    upsertChannel(qc, summary, true);
    expect(qc.getQueryData<Channel[]>(keys.channels)).toEqual([{ ...created, unreadCount: 3 }]);
  });
});
