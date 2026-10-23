import { useQuery } from "@tanstack/react-query";
import { CHANNEL_MENTION, mentionToken, type Channel, type Member } from "@chatter/shared";
import { api } from "./api";
import { keys } from "./cache";
import { useCurrentWorkspace } from "./workspace";

export type Names = ReadonlyMap<string, string>;

/** People of the current workspace. */
export function useDirectory() {
  const { id } = useCurrentWorkspace();
  // Kept current by member.* events; refetched after a reconnect.
  const users = useQuery({ queryKey: keys.members(id), queryFn: () => api.members(id) });
  const list = users.data ?? [];
  const names: Names = new Map(list.map((u) => [u.id, u.displayName]));
  const guests: ReadonlySet<string> = new Set(list.filter((u) => u.role === "guest").map((u) => u.id));
  return { users: list, names, guests };
}

export const nameOf = (names: Names, id: string) => names.get(id) ?? "알 수 없는 사용자";

/** Channels show their name; DMs are named after the other members. */
export function channelLabel(channel: Channel, names: Names, me: string): string {
  if (channel.kind !== "dm") return channel.name ?? "";
  const others = (channel.memberIds ?? []).filter((id) => id !== me);
  return others.length === 0 ? `${nameOf(names, me)} (나)` : others.map((id) => nameOf(names, id)).join(", ");
}

// The composer shows `@Name`; the server stores `<@id>`. A mapping of the
// names the user picked bridges the two, so a typed "@Kim" that was never
// picked stays plain text.

export type MentionMap = Map<string, string>; // display text "@Name" → user id

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function toTokens(text: string, picked: MentionMap): string {
  let out = text.replace(/(^|\s)@channel\b/g, `$1${CHANNEL_MENTION}`);
  // Longest first, so "@Kim Lee" wins over "@Kim".
  for (const [display, id] of [...picked].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${escape(display)}(?![\\p{L}\\p{N}_])`, "gu"), mentionToken(id));
  }
  return out;
}

export function toDisplay(text: string, names: Names): { text: string; picked: MentionMap } {
  const picked: MentionMap = new Map();
  const display = text
    .replaceAll(CHANNEL_MENTION, "@channel")
    .replace(/<@([0-9a-f-]{36})>/g, (_, id: string) => {
      const label = `@${nameOf(names, id)}`;
      picked.set(label, id);
      return label;
    });
  return { text: display, picked };
}

export function matchMembers(users: Member[], query: string, limit = 6): Member[] {
  const q = query.toLowerCase();
  return users.filter((u) => u.displayName.toLowerCase().includes(q)).slice(0, limit);
}
