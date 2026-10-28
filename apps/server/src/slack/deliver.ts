import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { slackId, type AppEventType, type AppReply, type Message } from "@chatter/shared";
import type { AppDeps } from "../app";
import type { AppRow } from "../apps";
import { channels } from "../db/schema";
import type { ChannelRow } from "../queries";
import { blocksText, fromSlackBlocks, fromSlackText } from "./format";
import { channelSlackId, channelType, messageTs } from "./ids";
import { messageContext, slackMessage } from "./objects";
import type { Delivery } from "./socket";

// What Socket Mode apps receive, in Slack's payload shapes: message events,
// slash commands and button clicks, plus how their replies map onto Chatter's.

/** Delays before each attempt; an acknowledgement ends delivery. Slack retries the same event id. */
const EVENT_ATTEMPT_DELAYS_MS = [0, 5_000, 30_000];
const EVENT_ACK_TIMEOUT_MS = 5_000;

const triggerId = () => `${Date.now()}.${randomBytes(8).toString("hex")}`;

/** Message events for one app, delivered over Socket Mode in the background (lost if the server stops). */
export async function deliverSlackEvents(
  deps: Pick<AppDeps, "db" | "socketMode">,
  app: AppRow,
  message: Message,
  types: AppEventType[],
  log: FastifyBaseLogger,
): Promise<void> {
  const [channel] = await deps.db.select().from(channels).where(eq(channels.id, message.channelId));
  if (!channel) return;
  const teamId = slackId("T", app.workspaceId);
  const base = { ...slackMessage(message, teamId, await messageContext(deps.db, [message])), channel: channelSlackId(channel), event_ts: messageTs(message) };
  // Slack sends the mention first; apps dedupe the pair by `ts`.
  for (const type of (["app_mention", "message"] as const).filter((t) => types.includes(t))) {
    const event = type === "message" ? { ...base, channel_type: channelType(channel) } : { ...base, type: "app_mention" };
    const payload = {
      token: "",
      team_id: teamId,
      api_app_id: slackId("A", app.id),
      event,
      type: "event_callback",
      event_id: `Ev${randomBytes(10).toString("hex").toUpperCase()}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ enterprise_id: null, team_id: teamId, user_id: slackId("U", app.botUserId), is_bot: true, is_enterprise_install: false }],
      is_ext_shared_channel: false,
      event_context: randomBytes(12).toString("hex"),
    };
    void retryEvent(deps, app, payload, log);
  }
}

async function retryEvent(deps: Pick<AppDeps, "socketMode">, app: AppRow, payload: { event_id: string }, log: FastifyBaseLogger) {
  for (const [attempt, delay] of EVENT_ATTEMPT_DELAYS_MS.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const delivery = await deps.socketMode
      .send(app.id, "events_api", payload, { retryAttempt: attempt, retryReason: attempt > 0 ? "timeout" : "", timeoutMs: EVENT_ACK_TIMEOUT_MS })
      .catch(() => ({ acked: false }) as const);
    if (delivery.acked) return;
  }
  log.warn({ appId: app.id, eventId: payload.event_id }, "socket mode event not acknowledged");
}

export function sendSlackCommand(
  deps: Pick<AppDeps, "socketMode">,
  app: AppRow,
  input: { command: string; text: string; channel: ChannelRow; user: { id: string; displayName: string }; responseUrl: string },
): Promise<Delivery> {
  const teamId = slackId("T", app.workspaceId);
  return deps.socketMode.send(
    app.id,
    "slash_commands",
    {
      token: "",
      team_id: teamId,
      team_domain: "chatter",
      channel_id: channelSlackId(input.channel),
      channel_name: input.channel.name ?? "directmessage",
      user_id: slackId("U", input.user.id),
      user_name: input.user.displayName,
      command: input.command,
      text: input.text,
      api_app_id: slackId("A", app.id),
      is_enterprise_install: "false",
      response_url: input.responseUrl,
      trigger_id: triggerId(),
    },
    { acceptsResponsePayload: true },
  );
}

export async function sendSlackBlockAction(
  deps: Pick<AppDeps, "db" | "socketMode">,
  app: AppRow,
  input: { message: Message; channel: ChannelRow; user: { id: string; displayName: string }; action: { actionId: string; value: string | null; text: string; blockId: string }; responseUrl: string },
): Promise<Delivery> {
  const teamId = slackId("T", app.workspaceId);
  const userId = slackId("U", input.user.id);
  const channelId = channelSlackId(input.channel);
  const message = slackMessage(input.message, teamId, await messageContext(deps.db, [input.message]));
  return deps.socketMode.send(app.id, "interactive", {
    type: "block_actions",
    team: { id: teamId, domain: "chatter" },
    user: { id: userId, username: input.user.displayName, name: input.user.displayName, team_id: teamId },
    api_app_id: slackId("A", app.id),
    token: "",
    trigger_id: triggerId(),
    container: { type: "message", message_ts: message.ts, channel_id: channelId, is_ephemeral: false },
    channel: { id: channelId, name: input.channel.name ?? "directmessage" },
    message,
    state: { values: {} },
    response_url: input.responseUrl,
    actions: [
      {
        action_id: input.action.actionId,
        block_id: input.action.blockId,
        type: "button",
        text: { type: "plain_text", text: input.action.text },
        ...(input.action.value !== null ? { value: input.action.value } : {}),
        action_ts: `${(Date.now() / 1000).toFixed(6)}`,
      },
    ],
  });
}

/**
 * A Slack reply (command acknowledgement or response URL body) as a Chatter
 * reply. Null when it says nothing; `deleteOriginal` asks to remove the
 * clicked message instead.
 */
export function fromSlackReply(body: unknown): { reply: AppReply | null; deleteOriginal: boolean } {
  if (typeof body !== "object" || body === null) return { reply: null, deleteOriginal: false };
  const b = body as Record<string, unknown>;
  const flag = (v: unknown) => v === true || v === "true";
  const blocks = fromSlackBlocks(b.blocks) ?? undefined;
  const text = (typeof b.text === "string" ? fromSlackText(b.text) : "").trim() || blocksText(blocks ?? null).trim();
  if (flag(b.delete_original)) return { reply: null, deleteOriginal: true };
  if (!text) return { reply: null, deleteOriginal: false };
  return {
    reply: {
      text: text.slice(0, 4000),
      blocks,
      responseType: b.response_type === "in_channel" ? "in_channel" : "ephemeral",
      replaceOriginal: flag(b.replace_original),
    },
    deleteOriginal: false,
  };
}
