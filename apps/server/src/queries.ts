import { and, eq, inArray, sql } from "drizzle-orm";
import { parseMentions, type Channel, type ChannelSummary, type FileRef, type Message, type NotifyLevel, type Reaction } from "@chatter/shared";
import type { Db } from "./db/client";
import { channelMembers, channels, files, messages, users } from "./db/schema";
import { fileRef } from "./files";
import { effectiveLevel } from "./notify";

// Single owner of the Channel and Message response shapes. Routes and realtime
// events both build them here so a REST response and the event for the same
// change are identical.

const PARTICIPANT_PREVIEW = 3;

export type ChannelRow = typeof channels.$inferSelect;

/**
 * The channel when `userId` may see it: public channels for everyone,
 * private channels and DMs only for members. Invisible and missing look the same.
 */
export async function channelAccess(db: Db, channelId: string, userId: string) {
  const [row] = await db
    .select({ channel: channels, memberId: channelMembers.userId })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row) return null;
  const isMember = row.memberId !== null;
  if (!isMember && row.channel.kind !== "public") return null;
  return { channel: row.channel, isMember };
}

export async function memberIds(db: Db, channelId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));
  return rows.map((r) => r.userId);
}

export async function channelSummary(db: Db, channel: ChannelRow): Promise<ChannelSummary> {
  return {
    id: channel.id,
    kind: channel.kind,
    name: channel.name,
    topic: channel.topic,
    memberIds: channel.kind === "dm" ? (await memberIds(db, channel.id)).sort() : null,
  };
}

/** Every conversation visible to `me` (or just `onlyId`), with their unread state. */
export async function listChannels(db: Db, me: string, onlyId?: string): Promise<Channel[]> {
  const { rows } = await db.execute<{
    id: string;
    kind: Channel["kind"];
    name: string | null;
    topic: string;
    is_member: boolean;
    notify: NotifyLevel | null;
    member_ids: string[] | null;
    unread_count: number;
    mention_count: number;
  }>(sql`
    select c.id, c.kind, c.name, c.topic,
           (cm.user_id is not null) as is_member,
           cm.notify,
           case when c.kind = 'dm' then (
             select array_agg(user_id::text order by user_id::text) from channel_members where channel_id = c.id
           ) end as member_ids,
           case when cm.user_id is null then 0 else (
             select count(*)::int from messages m
             where m.channel_id = c.id and m.id > cm.last_read_message_id and m.user_id <> ${me}
               and m.deleted_at is null and (m.parent_id is null or m.also_sent_to_channel)
           ) end as unread_count,
           case when cm.user_id is null then 0 else (
             select count(*)::int from mentions mn
             where mn.channel_id = c.id and mn.user_id = ${me} and mn.read_at is null
           ) end as mention_count
    from channels c
    left join channel_members cm on cm.channel_id = c.id and cm.user_id = ${me}
    where (c.kind = 'public' or cm.user_id is not null)
      ${onlyId ? sql`and c.id = ${onlyId}` : sql``}
    order by c.kind = 'dm', c.name, c.created_at`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    topic: r.topic,
    memberIds: r.member_ids,
    isMember: r.is_member,
    unreadCount: r.unread_count,
    mentionCount: r.mention_count,
    notify: effectiveLevel(r.notify, r.kind),
  }));
}

export async function channelFor(db: Db, me: string, channelId: string): Promise<Channel> {
  const [channel] = await listChannels(db, me, channelId);
  if (!channel) throw new Error(`channel ${channelId} is not visible to ${me}`);
  return channel;
}

/** Messages for the given ids, in the same order; missing ids are skipped. */
export async function loadMessages(db: Db, ids: number[]): Promise<Message[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ m: messages, authorName: users.displayName })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.userId))
    .where(inArray(messages.id, ids));

  const reactionRows = await db.execute<{ message_id: string; emoji: string; user_ids: string[] }>(sql`
    select message_id, emoji, array_agg(user_id::text order by created_at) as user_ids
    from reactions where message_id in ${ids}
    group by message_id, emoji order by min(created_at)`);
  const participantRows = await db.execute<{ parent_id: string; user_id: string }>(sql`
    select parent_id, user_id::text as user_id from (
      select parent_id, user_id, max(id) as last from messages
      where parent_id in ${ids} and deleted_at is null group by parent_id, user_id
    ) t order by parent_id, last desc`);

  const fileRows = await db
    .select({ id: files.id, messageId: files.messageId, name: files.name, mimeType: files.mimeType, size: files.size })
    .from(files)
    .where(inArray(files.messageId, ids))
    .orderBy(files.createdAt);
  const filesBy = new Map<number, FileRef[]>();
  for (const f of fileRows) {
    const list = filesBy.get(f.messageId!) ?? [];
    list.push(fileRef(f));
    filesBy.set(f.messageId!, list);
  }

  const reactionsBy = new Map<number, Reaction[]>();
  for (const r of reactionRows.rows) {
    const list = reactionsBy.get(Number(r.message_id)) ?? [];
    list.push({ emoji: r.emoji, userIds: r.user_ids });
    reactionsBy.set(Number(r.message_id), list);
  }
  const participantsBy = new Map<number, string[]>();
  for (const r of participantRows.rows) {
    const list = participantsBy.get(Number(r.parent_id)) ?? [];
    if (list.length < PARTICIPANT_PREVIEW) list.push(r.user_id);
    participantsBy.set(Number(r.parent_id), list);
  }

  const byId = new Map(
    rows.map(({ m, authorName }): [number, Message] => [
      m.id,
      {
        id: m.id,
        channelId: m.channelId,
        parentId: m.parentId,
        author: { id: m.userId, displayName: authorName },
        text: m.text,
        clientMsgId: m.clientMsgId,
        createdAt: m.createdAt.toISOString(),
        editedAt: m.editedAt?.toISOString() ?? null,
        deleted: m.deletedAt !== null,
        alsoSentToChannel: m.alsoSentToChannel,
        mentions: parseMentions(m.text).userIds,
        mentionsChannel: m.mentionsChannel,
        reactions: reactionsBy.get(m.id) ?? [],
        files: filesBy.get(m.id) ?? [],
        thread:
          m.replyCount > 0 && m.lastReplyAt
            ? { replyCount: m.replyCount, lastReplyAt: m.lastReplyAt.toISOString(), participantIds: participantsBy.get(m.id) ?? [] }
            : null,
      },
    ]),
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function loadMessage(db: Db, id: number): Promise<Message | null> {
  return (await loadMessages(db, [id]))[0] ?? null;
}
