import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, gt, sql } from "drizzle-orm";
import { appReply, type App, type AppScope, type Block, type EphemeralMessage } from "@chatter/shared";
import type { z } from "zod";
import type { AppDeps } from "./app";
import type { Db } from "./db/client";
import { apps, messages, responseUrls, slashCommands, users } from "./db/schema";
import { sendMessage } from "./messageService";
import { loadMessage, memberIds } from "./queries";
import type { RealtimeHub } from "./realtime";

// Single owner of apps: tokens, their view, and what an app's reply does
// (post in the conversation, show one person, or replace the clicked message).

export type AppRow = typeof apps.$inferSelect;

const RESPONSE_URL_USES = 5;
const RESPONSE_URL_TTL_MS = 30 * 60 * 1000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newBotToken = () => `xcb-${randomBytes(32).toString("base64url")}`;
export const newSigningSecret = () => randomBytes(24).toString("hex");

export async function appView(db: Db, app: AppRow, token?: string): Promise<App> {
  const commands = await db.select().from(slashCommands).where(eq(slashCommands.appId, app.id)).orderBy(slashCommands.command);
  return {
    id: app.id,
    name: app.name,
    botUserId: app.botUserId,
    scopes: app.scopes,
    eventsUrl: app.eventsUrl,
    eventTypes: app.eventTypes,
    interactivityUrl: app.interactivityUrl,
    signingSecret: app.signingSecret,
    createdAt: app.createdAt.toISOString(),
    commands: commands.map((c) => ({ id: c.id, appId: c.appId, command: c.command, url: c.url, description: c.description, usageHint: c.usageHint })),
    ...(token ? { token } : {}),
  };
}

export async function appByToken(db: Db, token: string): Promise<AppRow | null> {
  const [row] = await db.select().from(apps).where(eq(apps.tokenHash, hashToken(token)));
  return row ?? null;
}

export async function appByBot(db: Db, botUserId: string): Promise<AppRow | null> {
  const [row] = await db.select().from(apps).where(eq(apps.botUserId, botUserId));
  return row ?? null;
}

export const hasScope = (app: AppRow, scope: AppScope) => app.scopes.includes(scope);

/** Shows a message to one person in one conversation, without storing it. */
export function sendEphemeral(
  hub: RealtimeHub,
  userId: string,
  message: { channelId: string; parentId: number | null; author: { id: string; displayName: string }; text: string; blocks?: Block[] },
) {
  const ephemeral: EphemeralMessage = { id: randomUUID(), createdAt: new Date().toISOString(), ...message, blocks: message.blocks ?? null };
  hub.publish({ users: [userId] }, { type: "ephemeral", message: ephemeral });
}

export interface ReplyTarget {
  channelId: string;
  parentId: number | null;
  /** Who ran the command or clicked. */
  userId: string;
  /** The clicked message, which a reply may replace. */
  messageId?: number;
}

/** A URL the app may use a few times for late replies to the same person and conversation. */
export async function issueResponseUrl(db: Db, origin: string, app: AppRow, target: ReplyTarget): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.insert(responseUrls).values({
    tokenHash: hashToken(token),
    appId: app.id,
    channelId: target.channelId,
    parentId: target.parentId,
    userId: target.userId,
    messageId: target.messageId ?? null,
    usesLeft: RESPONSE_URL_USES,
    expiresAt: new Date(Date.now() + RESPONSE_URL_TTL_MS),
  });
  return `${origin}/api/response-urls/${token}`;
}

/** Spends one use of a response URL; null when unknown, expired or used up. */
export async function redeemResponseUrl(db: Db, token: string) {
  const [row] = await db
    .update(responseUrls)
    .set({ usesLeft: sql`${responseUrls.usesLeft} - 1` })
    .where(and(eq(responseUrls.tokenHash, hashToken(token)), gt(responseUrls.usesLeft, 0), gt(responseUrls.expiresAt, new Date())))
    .returning();
  if (!row) return null;
  const [app] = await db.select().from(apps).where(eq(apps.id, row.appId));
  return app ? { app, target: { channelId: row.channelId, parentId: row.parentId, userId: row.userId, messageId: row.messageId ?? undefined } } : null;
}

export async function botAuthor(db: Db, app: AppRow) {
  const [bot] = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, app.botUserId));
  return bot!;
}

/**
 * Carries out an app's reply: replace the clicked message, post in the
 * conversation as the app's bot, or show only the person who acted.
 */
export async function applyReply(
  deps: Pick<AppDeps, "db" | "hub" | "push" | "outbound">,
  app: AppRow,
  target: ReplyTarget,
  input: z.input<typeof appReply>,
  log: FastifyBaseLogger,
): Promise<void> {
  const reply = appReply.parse(input);
  const { db, hub } = deps;
  if (reply.replaceOriginal && target.messageId) {
    const [original] = await db.select({ userId: messages.userId, channelId: messages.channelId }).from(messages).where(eq(messages.id, target.messageId));
    // Only the app's own messages can be replaced by it.
    if (original && original.userId === app.botUserId) {
      await db.update(messages).set({ text: reply.text, blocks: reply.blocks ?? null }).where(eq(messages.id, target.messageId));
      const message = (await loadMessage(db, target.messageId))!;
      hub.publish({ users: await memberIds(db, original.channelId) }, { type: "message.updated", message });
      return;
    }
  }
  if (reply.responseType === "in_channel") {
    await sendMessage(
      deps,
      target.channelId,
      app.botUserId,
      {
        text: reply.text,
        blocks: reply.blocks,
        clientMsgId: randomUUID(),
        parentId: target.parentId ?? undefined,
        alsoSendToChannel: false,
        fileIds: [],
      },
      log,
    );
    return;
  }
  sendEphemeral(hub, target.userId, {
    channelId: target.channelId,
    parentId: target.parentId,
    author: await botAuthor(db, app),
    text: reply.text,
    blocks: reply.blocks,
  });
}
