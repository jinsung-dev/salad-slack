import { z } from "zod";

// Request contracts. The server parses every boundary value with these;
// the client reuses them for form validation.

export const channelNameSchema = z
  .string()
  .trim()
  // One spelling per name: composed Hangul (NFC) and lowercase Latin, so "개발" or "Dev" cannot exist twice.
  .transform((s) => s.normalize("NFC").toLowerCase())
  .pipe(
    z
      .string()
      .regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u, "글자(한글·영문 등), 숫자, -, _ 만 쓸 수 있고 공백은 안 됩니다 (최대 80자)"),
  );

export const createChannelInput = z.object({
  name: channelNameSchema,
  topic: z.string().trim().max(250).default(""),
  isPrivate: z.boolean().default(false),
});
export type CreateChannelInput = z.input<typeof createChannelInput>;

/** Group DMs hold at most this many people, the sender included. */
export const MAX_DM_MEMBERS = 8;

export const createDmInput = z.object({
  userIds: z.array(z.uuid()).min(1).max(MAX_DM_MEMBERS - 1),
});

export const inviteInput = z.object({
  userIds: z.array(z.uuid()).min(1).max(50),
});

export const messageText = z.string().trim().min(1).max(4000);

export const postMessageInput = z.object({
  text: messageText,
  // Client-generated idempotency key: retries of the same send never duplicate.
  clientMsgId: z.string().min(1).max(64),
  /** Reply in this message's thread. */
  parentId: z.number().int().positive().optional(),
  /** A thread reply that also appears in the channel. */
  alsoSendToChannel: z.boolean().default(false),
});
export type PostMessageInput = z.input<typeof postMessageInput>;

export const editMessageInput = z.object({ text: messageText });

export const markReadInput = z.object({
  messageId: z.number().int().nonnegative(),
});

export const channelParams = z.object({ id: z.uuid() });
export const messageParams = z.object({ id: z.coerce.number().int().positive() });
export const reactionParams = messageParams.extend({
  emoji: z.string().min(1).max(32).regex(/^\S+$/u),
});

export const historyQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Mentions are stored inline as tokens so edits and display names never drift:
// `<@user-uuid>` mentions one person, `<!channel>` everyone in the conversation.

export const CHANNEL_MENTION = "<!channel>";
const USER_MENTION = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

export const mentionToken = (userId: string) => `<@${userId}>`;

export function parseMentions(text: string): { userIds: string[]; channel: boolean } {
  const userIds = new Set<string>();
  for (const match of text.matchAll(USER_MENTION)) userIds.add(match[1]!);
  return { userIds: [...userIds], channel: text.includes(CHANNEL_MENTION) };
}

// Client → server realtime messages. Ephemeral only: nothing here is persisted,
// so writes keep a single validated REST path.

export const clientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typing"), channelId: z.uuid(), parentId: z.number().int().positive().nullable() }),
  z.object({ type: z.literal("presence"), status: z.enum(["active", "away"]) }),
]);
export type ClientEvent = z.infer<typeof clientEvent>;

// Response shapes.

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export interface Member {
  id: string;
  displayName: string;
}

export type ChannelKind = "public" | "private" | "dm";

export interface ChannelSummary {
  id: string;
  kind: ChannelKind;
  /** Null for DMs, which are named after their members. */
  name: string | null;
  topic: string;
  /** Every member for DMs; null for channels. */
  memberIds: string[] | null;
}

export interface Channel extends ChannelSummary {
  isMember: boolean;
  /** Unread channel-level messages from others. */
  unreadCount: number;
  /** Unread mentions of the viewer, thread replies included. */
  mentionCount: number;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: string;
  /** Up to three most recent distinct reply authors. */
  participantIds: string[];
}

export interface Message {
  /** Monotonic per server; doubles as the pagination and read cursor. */
  id: number;
  channelId: string;
  /** Set for thread replies. */
  parentId: number | null;
  author: { id: string; displayName: string };
  /** Empty once deleted. */
  text: string;
  clientMsgId: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  alsoSentToChannel: boolean;
  mentions: string[];
  mentionsChannel: boolean;
  reactions: Reaction[];
  /** Null when the message has no replies. */
  thread: ThreadSummary | null;
}

export interface MessagePage {
  /** Ascending by id. */
  messages: Message[];
  hasMore: boolean;
}

export type PresenceStatus = "active" | "away" | "offline";

/** Users absent from the map are offline. */
export type PresenceMap = Record<string, Exclude<PresenceStatus, "offline">>;

// Realtime events pushed over /api/ws.

export type ServerEvent =
  | { type: "hello"; userId: string }
  | { type: "message.created"; message: Message }
  | { type: "message.updated"; message: Message }
  | { type: "message.deleted"; channelId: string; id: number; parentId: number | null }
  | { type: "reaction.updated"; channelId: string; messageId: number; reactions: Reaction[] }
  /**
   * A conversation became visible to the recipient or they joined it. Carries
   * the recipient's own membership; per-user counts come from the channel list.
   */
  | { type: "channel.added"; channel: ChannelSummary; isMember: boolean }
  | { type: "member.joined"; member: Member }
  | { type: "presence.changed"; userId: string; status: PresenceStatus }
  | { type: "typing"; channelId: string; parentId: number | null; userId: string };
