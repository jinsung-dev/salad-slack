import { inArray } from "drizzle-orm";
import { slackId, type Message } from "@chatter/shared";
import type { Db } from "../db/client";
import { messages, users } from "../db/schema";
import type { ChannelRow } from "../queries";
import { nameForEmoji } from "./emoji";
import { toSlackBlocks, toSlackText } from "./format";
import { channelSlackId, messageTs } from "./ids";

// Slack Web API object shapes built from Chatter rows: users, conversations
// and messages. Message objects are what events carry and what history
// methods return, so both read the same.

type SlackObject = Record<string, unknown>;

const seconds = (date: Date | string) => Math.floor(new Date(date).getTime() / 1000);

export function slackUser(row: { id: string; displayName: string; kind: "person" | "bot"; timeZone: string }, teamId: string): SlackObject {
  const isBot = row.kind === "bot";
  return {
    id: slackId("U", row.id),
    team_id: teamId,
    name: row.displayName,
    real_name: row.displayName,
    deleted: false,
    is_bot: isBot,
    is_app_user: false,
    tz: row.timeZone,
    profile: { display_name: row.displayName, real_name: row.displayName, ...(isBot ? { bot_id: slackId("B", row.id) } : {}) },
  };
}

/** A conversation as `viewerId` (the app's bot) sees it. */
export function slackChannel(row: ChannelRow, { teamId, viewerId, isMember }: { teamId: string; viewerId: string; isMember: boolean }): SlackObject {
  const id = channelSlackId(row);
  const members = row.dmKey?.split(",") ?? [];
  const isIm = id.startsWith("D");
  const other = members.find((m) => m !== viewerId);
  return {
    id,
    ...(row.name !== null ? { name: row.name, name_normalized: row.name } : {}),
    is_channel: row.kind !== "dm",
    is_group: false,
    is_im: isIm,
    is_mpim: id.startsWith("G"),
    is_private: row.kind !== "public",
    is_member: isMember,
    is_archived: false,
    is_general: false,
    created: seconds(row.createdAt),
    creator: slackId("U", row.createdBy),
    context_team_id: teamId,
    topic: { value: row.topic, creator: "", last_set: 0 },
    purpose: { value: "", creator: "", last_set: 0 },
    ...(isIm && other ? { user: slackId("U", other) } : {}),
  };
}

/** What converting messages needs beyond the messages themselves: author kinds and thread parents' timestamps. */
export async function messageContext(db: Db, list: Message[]) {
  const authorIds = [...new Set(list.map((m) => m.author.id))];
  const parentIds = [...new Set(list.flatMap((m) => (m.parentId === null ? [] : [m.parentId])))];
  const authorRows = authorIds.length > 0 ? await db.select({ id: users.id, kind: users.kind }).from(users).where(inArray(users.id, authorIds)) : [];
  const parentRows =
    parentIds.length > 0
      ? await db.select({ id: messages.id, createdAt: messages.createdAt, userId: messages.userId }).from(messages).where(inArray(messages.id, parentIds))
      : [];
  return {
    bots: new Set(authorRows.filter((r) => r.kind === "bot").map((r) => r.id)),
    parents: new Map(parentRows.map((p) => [p.id, { ts: messageTs(p), userId: p.userId }])),
  };
}

export type MessageContext = Awaited<ReturnType<typeof messageContext>>;

export function slackMessage(message: Message, teamId: string, context: MessageContext): SlackObject {
  const ts = messageTs(message);
  const isBot = context.bots.has(message.author.id);
  const parent = message.parentId === null ? undefined : context.parents.get(message.parentId);
  return {
    type: "message",
    user: slackId("U", message.author.id),
    text: toSlackText(message.text),
    ts,
    team: teamId,
    // Slack clients stamp people's posts; API posts (bots) have none.
    ...(isBot ? { bot_id: slackId("B", message.author.id) } : { client_msg_id: message.clientMsgId }),
    ...(parent ? { thread_ts: parent.ts, parent_user_id: slackId("U", parent.userId) } : {}),
    ...(message.thread
      ? {
          thread_ts: ts,
          reply_count: message.thread.replyCount,
          reply_users: message.thread.participantIds.map((id) => slackId("U", id)),
          latest_reply: String(seconds(message.thread.lastReplyAt)),
        }
      : {}),
    ...(message.blocks ? { blocks: toSlackBlocks(message.blocks) } : {}),
    ...(message.editedAt ? { edited: { user: slackId("U", message.author.id), ts: `${seconds(message.editedAt)}.000000` } } : {}),
    ...(message.reactions.length > 0
      ? { reactions: message.reactions.map((r) => ({ name: nameForEmoji(r.emoji), users: r.userIds.map((id) => slackId("U", id)), count: r.userIds.length })) }
      : {}),
    ...(message.alsoSentToChannel ? { subtype: "thread_broadcast" } : {}),
  };
}

export async function slackMessages(db: Db, list: Message[], teamId: string): Promise<SlackObject[]> {
  const context = await messageContext(db, list);
  return list.map((m) => slackMessage(m, teamId, context));
}
