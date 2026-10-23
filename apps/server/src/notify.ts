import { eq, inArray } from "drizzle-orm";
import { CHANNEL_MENTION, defaultNotifyLevel, type Message, type NotifyLevel } from "@chatter/shared";
import type { Db } from "./db/client";
import { channelMembers, channels, messages, pushSubscriptions, users } from "./db/schema";
import type { RealtimeHub } from "./realtime";

// Single owner of "who gets a push notification for this message" and what
// it says. Clients never repeat this decision.

export type ConversationKind = "public" | "private" | "dm";

export const effectiveLevel = (stored: NotifyLevel | null, kind: ConversationKind): NotifyLevel => stored ?? defaultNotifyLevel(kind);

export interface Recipient {
  userId: string;
  level: NotifyLevel;
  /** Author of the thread this message replies to. */
  ownsThread: boolean;
}

/** Whether a message warrants notifying this member, before focus and quiet hours. */
export function wantsNotification(message: Message, recipient: Recipient): boolean {
  if (message.author.id === recipient.userId || recipient.level === "none") return false;
  const mentioned = message.mentionsChannel || message.mentions.includes(recipient.userId);
  // Thread replies stay in the thread unless they mention you or answer your thread.
  if (message.parentId !== null && !message.alsoSentToChannel) return mentioned || recipient.ownsThread;
  return recipient.level === "all" || mentioned;
}

export interface QuietHours {
  enabled: boolean;
  /** Minutes after local midnight. */
  start: number;
  end: number;
  timeZone: string;
}

export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const minutes = Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
  return quiet.start < quiet.end ? minutes >= quiet.start && minutes < quiet.end : minutes >= quiet.start || minutes < quiet.end;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path to open on click. */
  url: string;
  /** Collapses repeats of the same message. */
  tag: string;
}

const PREVIEW_CHARS = 140;

export function pushPayload(message: Message, conversation: { kind: ConversationKind; name: string | null }, names: ReadonlyMap<string, string>): PushPayload {
  const text = message.text
    .replaceAll(CHANNEL_MENTION, "@channel")
    .replace(/<@([0-9a-f-]{36})>/g, (_, id: string) => `@${names.get(id) ?? "알 수 없음"}`)
    .replace(/\s+/g, " ")
    .trim();
  const content = text || (message.files.length > 0 ? `파일 ${message.files.length}개` : "");
  const preview = content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS - 1)}…` : content;
  const author = message.author.displayName;
  const inThread = message.parentId !== null;
  return {
    title: conversation.kind === "dm" ? author : `#${conversation.name}${inThread ? " 스레드" : ""}`,
    body: conversation.kind === "dm" ? preview : `${author}: ${preview}`,
    url: `/c/${message.channelId}${inThread ? `/t/${message.parentId}` : ""}`,
    tag: `message-${message.id}`,
  };
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Delivers one encrypted payload; `gone` means the browser dropped the subscription. */
export type PushSender = (target: PushTarget, payload: string) => Promise<{ gone: boolean }>;

/** Sends push notifications for a new message to everyone who should get one. */
export async function notifyNewMessage(db: Db, hub: RealtimeHub, send: PushSender, message: Message, now = new Date()) {
  const [conversation] = await db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, message.channelId));
  if (!conversation) return;
  const threadOwner =
    message.parentId === null
      ? null
      : ((await db.select({ userId: messages.userId }).from(messages).where(eq(messages.id, message.parentId)))[0]?.userId ?? null);

  const members = await db
    .select({
      userId: channelMembers.userId,
      notify: channelMembers.notify,
      timeZone: users.timeZone,
      quietEnabled: users.quietHoursEnabled,
      quietStart: users.quietHoursStart,
      quietEnd: users.quietHoursEnd,
    })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(eq(channelMembers.channelId, message.channelId));

  const candidates = members.filter(
    (m) =>
      wantsNotification(message, { userId: m.userId, level: effectiveLevel(m.notify, conversation.kind), ownsThread: m.userId === threadOwner }) &&
      !inQuietHours({ enabled: m.quietEnabled, start: m.quietStart, end: m.quietEnd, timeZone: m.timeZone }, now),
  );
  if (candidates.length === 0) return;
  const focused = await hub.focusedUsers();
  const recipients = candidates.map((m) => m.userId).filter((id) => !focused.has(id));
  if (recipients.length === 0) return;

  const targets = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, recipients));
  if (targets.length === 0) return;
  const named = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, message.mentions.length > 0 ? message.mentions : [message.author.id]));
  const payload = JSON.stringify(pushPayload(message, conversation, new Map(named.map((u) => [u.id, u.displayName]))));

  const results = await Promise.allSettled(targets.map((t) => send(t, payload)));
  const gone = targets.filter((_, i) => {
    const r = results[i]!;
    return r.status === "fulfilled" && r.value.gone;
  });
  if (gone.length > 0) {
    await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.endpoint, gone.map((t) => t.endpoint)));
  }
}
