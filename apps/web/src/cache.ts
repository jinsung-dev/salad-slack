import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  defaultNotifyLevel,
  type Channel,
  type ChannelSummary,
  type Member,
  type Message,
  type MessagePage,
  type PresenceMap,
  type PresenceStatus,
  type Workspace,
} from "@chatter/shared";

// Single owner of client-side cache mutations, shared by realtime events and
// local REST responses so both paths deduplicate the same way.

export const keys = {
  me: ["me"] as const,
  workspaces: ["workspaces"] as const,
  members: (workspaceId: string) => ["members", workspaceId] as const,
  presence: (workspaceId: string) => ["presence", workspaceId] as const,
  channels: (workspaceId: string) => ["channels", workspaceId] as const,
  /** Channel-level history: top-level messages and replies also sent to the channel. */
  messages: (channelId: string) => ["messages", channelId] as const,
  /** Replies of one thread. */
  thread: (parentId: number) => ["thread", parentId] as const,
  message: (id: number) => ["message", id] as const,
  saved: (workspaceId: string) => ["saved", workspaceId] as const,
};

type Pages = InfiniteData<MessagePage, number | undefined>;

/** Pages are newest-first; messages inside each page are ascending. */
export function flattenPages(data: { pages: MessagePage[] } | undefined): Message[] {
  return data ? [...data.pages].reverse().flatMap((p) => p.messages) : [];
}

const inChannel = (m: Message) => m.parentId === null || m.alsoSentToChannel;

function appendTo(qc: QueryClient, key: QueryKey, message: Message): boolean {
  let added = false;
  qc.setQueryData<Pages>(key, (data) => {
    if (!data || data.pages.length === 0) return data;
    if (data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return data;
    added = true;
    const [newest, ...rest] = data.pages;
    return { ...data, pages: [{ ...newest!, messages: [...newest!.messages, message] }, ...rest] };
  });
  return added;
}

/** Adds a new message to every list it belongs in; a no-op for lists not loaded. */
export function appendMessage(qc: QueryClient, message: Message) {
  if (inChannel(message)) appendTo(qc, keys.messages(message.channelId), message);
  if (message.parentId !== null) appendTo(qc, keys.thread(message.parentId), message);
}

function mapPages(qc: QueryClient, key: QueryKey, fn: (messages: Message[]) => Message[]) {
  qc.setQueriesData<Pages>({ queryKey: key }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, messages: fn(p.messages) })) } : data,
  );
}

/** Applies `fn` to message `id` wherever it is cached. */
export function updateMessage(qc: QueryClient, channelId: string, id: number, fn: (m: Message) => Message) {
  const each = (list: Message[]) => list.map((m) => (m.id === id ? fn(m) : m));
  mapPages(qc, keys.messages(channelId), each);
  mapPages(qc, ["thread"], each);
  qc.setQueryData<Message>(keys.message(id), (m) => (m ? fn(m) : m));
}

export function replaceMessage(qc: QueryClient, message: Message) {
  updateMessage(qc, message.channelId, message.id, () => message);
}

export function removeMessage(qc: QueryClient, channelId: string, id: number) {
  const without = (list: Message[]) => list.filter((m) => m.id !== id);
  mapPages(qc, keys.messages(channelId), without);
  mapPages(qc, ["thread"], without);
  qc.removeQueries({ queryKey: keys.message(id) });
  qc.removeQueries({ queryKey: keys.thread(id) });
}

/**
 * A summary from a realtime event sets membership but carries no per-user
 * counts, so it keeps counts already known; a full Channel from the API
 * replaces. The two can arrive in either order.
 */
export function upsertChannel(qc: QueryClient, channel: ChannelSummary | Channel, isMember?: boolean) {
  qc.setQueryData<Channel[]>(keys.channels(channel.workspaceId), (list) => {
    if (!list) return list;
    const existing = list.find((c) => c.id === channel.id);
    const next: Channel =
      "unreadCount" in channel
        ? channel
        : {
            unreadCount: 0,
            mentionCount: 0,
            notify: defaultNotifyLevel(channel.kind),
            ...existing,
            ...channel,
            isMember: isMember ?? existing?.isMember ?? false,
          };
    return [...list.filter((c) => c.id !== channel.id), next];
  });
}

/** Channel ids are global, so the change applies to whichever workspace list holds it. */
export function updateChannel(qc: QueryClient, id: string, update: (c: Channel) => Channel) {
  qc.setQueriesData<Channel[]>({ queryKey: ["channels"] }, (list) => list?.map((c) => (c.id === id ? update(c) : c)));
}

export function upsertMember(qc: QueryClient, workspaceId: string, member: Member) {
  qc.setQueryData<Member[]>(keys.members(workspaceId), (list) =>
    list ? [...list.filter((u) => u.id !== member.id), member].sort((a, b) => a.displayName.localeCompare(b.displayName)) : list,
  );
}

export function removeMember(qc: QueryClient, workspaceId: string, userId: string) {
  qc.setQueryData<Member[]>(keys.members(workspaceId), (list) => list?.filter((u) => u.id !== userId));
}

/** Everything cached for one workspace, e.g. after leaving it. */
export function forgetWorkspace(qc: QueryClient, workspaceId: string) {
  for (const key of [keys.channels(workspaceId), keys.members(workspaceId), keys.presence(workspaceId), keys.saved(workspaceId)]) {
    qc.removeQueries({ queryKey: key });
  }
  qc.setQueryData<Workspace[]>(keys.workspaces, (list) => list?.filter((w) => w.id !== workspaceId));
}

export function setPresence(qc: QueryClient, userId: string, status: PresenceStatus) {
  qc.setQueriesData<PresenceMap>({ queryKey: ["presence"] }, (map) => {
    if (!map) return map;
    const next = { ...map };
    if (status === "offline") delete next[userId];
    else next[userId] = status;
    return next;
  });
}
