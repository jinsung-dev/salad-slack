import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull } from "drizzle-orm";
import type { AppEventType, Message } from "@chatter/shared";
import type { Db } from "./db/client";
import { apps, channelMembers, channels } from "./db/schema";
import { OutboundError, postSigned, type OutboundPolicy } from "./outbound";

// Event subscriptions: apps whose bot is in a conversation hear about new
// messages there (`message`) or about being mentioned (`app_mention`).

/** Delays before each attempt; a 2xx ends delivery, anything else retries. */
const ATTEMPT_DELAYS_MS = [0, 1_000, 5_000];

export interface EventCallback {
  type: "event_callback";
  eventId: string;
  eventTime: number;
  appId: string;
  workspaceId: string;
  event: { type: AppEventType; channelId: string; message: Message };
}

/** Which subscribed events a message raises for an app whose bot is in its conversation. */
export function eventsFor(message: Message, botUserId: string, subscribed: AppEventType[]): AppEventType[] {
  if (message.author.id === botUserId) return [];
  const raised: AppEventType[] = [];
  if (subscribed.includes("message")) raised.push("message");
  if (subscribed.includes("app_mention") && message.mentions.includes(botUserId)) raised.push("app_mention");
  return raised;
}

async function deliver(url: string, secret: string, payload: EventCallback, policy: OutboundPolicy, log: FastifyBaseLogger) {
  for (const [attempt, delay] of ATTEMPT_DELAYS_MS.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await postSigned(url, payload, secret, policy, { headers: attempt > 0 ? { "x-chatter-retry-num": String(attempt) } : {} });
      if (res.status >= 200 && res.status < 300) return;
      // A client error will not change on retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      // A blocked or invalid URL will not change on retry either.
      if (err instanceof OutboundError && (err.reason === "blocked_address" || err.reason === "invalid_url")) {
        log.warn({ appId: payload.appId, reason: err.reason }, "app event URL refused");
        return;
      }
    }
  }
  log.warn({ appId: payload.appId, eventId: payload.eventId }, "app event not delivered");
}

/** Fire and forget from the send path; deliveries retry in the background (lost if the server stops). */
export async function dispatchMessageEvents(db: Db, policy: OutboundPolicy, message: Message, log: FastifyBaseLogger) {
  const subscribers = await db
    .select({ app: apps, workspaceId: channels.workspaceId })
    .from(apps)
    .innerJoin(channelMembers, and(eq(channelMembers.userId, apps.botUserId), eq(channelMembers.channelId, message.channelId)))
    .innerJoin(channels, eq(channels.id, message.channelId))
    .where(isNotNull(apps.eventsUrl));
  for (const { app, workspaceId } of subscribers) {
    for (const type of eventsFor(message, app.botUserId, app.eventTypes)) {
      const payload: EventCallback = {
        type: "event_callback",
        eventId: randomUUID(),
        eventTime: Math.floor(Date.now() / 1000),
        appId: app.id,
        workspaceId,
        event: { type, channelId: message.channelId, message },
      };
      void deliver(app.eventsUrl!, app.signingSecret, payload, policy, log);
    }
  }
}
