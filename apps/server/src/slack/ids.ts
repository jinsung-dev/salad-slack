import { and, eq, gte, lt, sql } from "drizzle-orm";
import { slackId, type SlackIdKind } from "@chatter/shared";
import type { Db } from "../db/client";
import { messages } from "../db/schema";
import type { MessageRow } from "../messageService";
import type { ChannelRow } from "../queries";

// Slack-compatible identifiers. Object ids are a kind letter plus the Chatter
// UUID (`slackId` in @chatter/shared), so they convert both ways without
// storage. Message timestamps are "<creation second>.<id mod 10^6>": ordered
// like Slack's, and unique within a channel unless a million messages share
// one second.

const SLACK_ID = /^([A-Z])([0-9A-F]{32})$/;
const TS = /^(\d{1,12})\.(\d{6})$/;
const MICROS = 1_000_000;

/** The Chatter UUID behind a Slack id of one of `kinds`; null for anything else. */
export function fromSlackId(id: unknown, kinds: readonly SlackIdKind[]): string | null {
  const match = typeof id === "string" ? SLACK_ID.exec(id) : null;
  if (!match || !kinds.includes(match[1] as SlackIdKind)) return null;
  const hex = match[2]!.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const CHANNEL_KINDS = ["C", "D", "G"] as const;

/** Public and private channels are C, DMs between two people D, group DMs G. */
export function channelSlackId(channel: Pick<ChannelRow, "id" | "kind" | "dmKey">): string {
  return slackId(channelLetter(channel), channel.id);
}

function channelLetter(channel: Pick<ChannelRow, "kind" | "dmKey">): SlackIdKind {
  if (channel.kind !== "dm") return "C";
  return channel.dmKey!.split(",").length === 2 ? "D" : "G";
}

/** Slack's `channel_type` in message events. */
export function channelType(channel: Pick<ChannelRow, "kind" | "dmKey">): "channel" | "group" | "im" | "mpim" {
  if (channel.kind === "public") return "channel";
  if (channel.kind === "private") return "group";
  return channelLetter(channel) === "D" ? "im" : "mpim";
}

export function messageTs(message: { id: number; createdAt: Date | string }): string {
  const seconds = Math.floor(new Date(message.createdAt).getTime() / 1000);
  return `${seconds}.${String(message.id % MICROS).padStart(6, "0")}`;
}

/** The message of a channel a Slack timestamp names, deleted ones included; null when none. */
export async function messageByTs(db: Db, channelId: string, ts: unknown): Promise<MessageRow | null> {
  const match = typeof ts === "string" ? TS.exec(ts) : null;
  if (!match) return null;
  const second = new Date(Number(match[1]) * 1000);
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        gte(messages.createdAt, second),
        lt(messages.createdAt, new Date(second.getTime() + 1000)),
        sql`${messages.id} % ${MICROS} = ${Number(match[2])}`,
      ),
    )
    .limit(1);
  return row ?? null;
}
