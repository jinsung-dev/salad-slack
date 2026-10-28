import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { slackId, type AppScope, type Block } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { appByAppToken, appByBot, appByToken, applyReply, botAuthor, hashToken, redeemResponseUrl, sendEphemeral, type AppRow } from "../apps";
import { apps, channelMembers, channels, messages, reactions, users, workspaceMembers, workspaces } from "../db/schema";
import { deleteMessage, editMessage, sendMessage, setReaction, type MessageRow } from "../messageService";
import { channelAccess, loadMessages, memberIds, openDm, type ChannelRow } from "../queries";
import { fromSlackReply } from "../slack/deliver";
import { emojiForName } from "../slack/emoji";
import { blocksText, fromMarkdown, fromSlackBlocks, fromSlackText, toSlackText } from "../slack/format";
import { CHANNEL_KINDS, channelSlackId, fromSlackId, messageByTs, messageTs } from "../slack/ids";
import { slackChannel, slackMessages, slackUser } from "../slack/objects";
import { MAX_CONNECTIONS_PER_APP } from "../slack/socket";

// A subset of Slack's Web API (https://api.slack.com/methods) at /api/slack/,
// plus Socket Mode and Slack-shaped response URLs, so Slack apps built on
// Bolt or slack_sdk work by pointing their API base URL here. Every answer is
// HTTP 200 JSON with `ok`; failures carry Slack's error codes. Ids and text
// convert at this boundary (`slack/`); everything else is Chatter's own logic.

/** Slack's chat.postMessage limit. */
const MAX_TEXT = 40_000;
const PAGE_MAX = 200;
/** Fields form-encoded clients send as JSON strings. */
const STRUCTURED = ["blocks", "attachments", "metadata"];

class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Params = Record<string, unknown>;

interface Ctx {
  app: AppRow;
  teamId: string;
  params: Params;
  req: FastifyRequest;
}

interface Method {
  scope?: AppScope;
  run(ctx: Ctx): Promise<Record<string, unknown>>;
}

/** Slack scopes an app holding these Chatter scopes effectively has, for `x-oauth-scopes`. */
const SLACK_SCOPES: Record<AppScope, string[]> = {
  "chat:write": ["chat:write", "im:write", "mpim:write", "reactions:write", "assistant:write"],
  "channels:read": ["channels:read", "groups:read", "im:read", "mpim:read"],
  "channels:history": ["channels:history", "groups:history", "im:history", "mpim:history", "reactions:read"],
  "users:read": ["users:read"],
};
const slackScopes = (app: AppRow) => ["app_mentions:read", "commands", ...app.scopes.flatMap((s) => SLACK_SCOPES[s])].join(",");

const tokenParams = z.object({ token: z.string().min(16).max(128) });

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const flag = (v: unknown) => v === true || v === "true" || v === "1";
const limitOf = (v: unknown, fallback: number) => Math.min(Math.max(Number(v) || fallback, 1), PAGE_MAX);
const cursorOf = (v: unknown) => {
  const n = Number(str(v));
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

function readParams(req: FastifyRequest): Params {
  const params: Params = { ...(req.query as Params), ...(typeof req.body === "object" && req.body !== null ? (req.body as Params) : {}) };
  for (const key of STRUCTURED) {
    const value = params[key];
    if (typeof value === "string" && /^\s*[[{]/.test(value)) {
      try {
        params[key] = JSON.parse(value);
      } catch {
        throw new SlackError(key === "blocks" ? "invalid_blocks_format" : "invalid_arguments");
      }
    }
  }
  return params;
}

export async function slackApiRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, hub, socketMode, publicUrl } = deps;
  const origin = (req: FastifyRequest) => publicUrl ?? `${req.protocol}://${req.host}`;

  // Slack clients send most methods form-encoded; this parser only applies under this plugin.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof SlackError) return reply.code(200).send({ ok: false, error: error.code, ...error.extra });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ ok: false, error: "ratelimited" });
    if (status !== undefined && status >= 400 && status < 500) return reply.code(200).send({ ok: false, error: "invalid_arguments" });
    req.log.error(error);
    return reply.code(200).send({ ok: false, error: "fatal_error" });
  });

  const tokenOf = (req: FastifyRequest, params: Params) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? str(params.token);
  const limit = {
    rateLimit: {
      max: 600,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest) => (req.headers.authorization ? hashToken(req.headers.authorization) : req.ip),
    },
  };

  // Lookups shared by methods --------------------------------------------------

  /** A conversation of the app's workspace the bot may see; `member` also requires it to be in it. */
  const conversation = async (ctx: Ctx, id: unknown, { member = true } = {}) => {
    const channelId = fromSlackId(id, CHANNEL_KINDS);
    const access = channelId ? await channelAccess(db, channelId, ctx.app.botUserId) : null;
    if (!access || access.channel.workspaceId !== ctx.app.workspaceId) throw new SlackError("channel_not_found");
    if (member && !access.isMember) throw new SlackError("not_in_channel");
    return access;
  };

  /** A person or bot of the app's workspace by Slack user id. */
  const workspaceUser = async (ctx: Ctx, id: unknown) => {
    const userId = fromSlackId(id, ["U"]);
    const [row] = userId
      ? await db
          .select({ id: users.id, displayName: users.displayName, kind: users.kind, timeZone: users.timeZone })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, ctx.app.workspaceId), eq(workspaceMembers.userId, userId)))
      : [];
    if (!row) throw new SlackError("user_not_found");
    return row;
  };

  const message = async (channel: ChannelRow, ts: unknown): Promise<MessageRow> => {
    const row = await messageByTs(db, channel.id, ts);
    if (!row || row.deletedAt) throw new SlackError("message_not_found");
    return row;
  };

  /** The top-level message a `thread_ts` names (a reply's ts names its thread). */
  const threadParent = async (channel: ChannelRow, ts: unknown): Promise<MessageRow> => {
    const row = await messageByTs(db, channel.id, ts);
    if (!row) throw new SlackError("thread_not_found");
    if (row.parentId === null) return row;
    const [parent] = await db.select().from(messages).where(eq(messages.id, row.parentId));
    return parent!;
  };

  /** Message content from `text` (mrkdwn) or `markdown_text`, with blocks; undefined fields are absent. */
  const content = (params: Params, { required }: { required: boolean }) => {
    if (params.blocks !== undefined && !Array.isArray(params.blocks)) throw new SlackError("invalid_blocks");
    if (Array.isArray(params.blocks) && params.blocks.length > 50) throw new SlackError("invalid_blocks");
    const blocks: Block[] | null | undefined = params.blocks === undefined ? undefined : fromSlackBlocks(params.blocks);
    const markdown = str(params.markdown_text);
    const raw = markdown !== undefined ? fromMarkdown(markdown) : str(params.text) !== undefined ? fromSlackText(str(params.text)!) : undefined;
    const attachmentText = Array.isArray(params.attachments)
      ? params.attachments.map((a) => (typeof a === "object" && a ? str((a as Params).text) ?? str((a as Params).fallback) : undefined)).filter(Boolean).join("\n")
      : "";
    const text = raw?.trim() || blocksText(blocks ?? null) || (attachmentText ? fromSlackText(attachmentText) : "");
    if (!text && (required || params.blocks !== undefined)) throw new SlackError("no_text");
    if (text.length > MAX_TEXT) throw new SlackError("msg_too_long");
    return { text: text || undefined, blocks };
  };

  const toMessages = (list: Awaited<ReturnType<typeof loadMessages>>, ctx: Ctx) => slackMessages(db, list, ctx.teamId);

  // Methods ------------------------------------------------------------------

  const methods: Record<string, Method> = {
    "auth.test": {
      async run({ app: row, teamId, req }) {
        const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, row.workspaceId));
        const bot = await botAuthor(db, row);
        return {
          url: `${origin(req)}/`,
          team: workspace?.name ?? "",
          user: bot.displayName,
          team_id: teamId,
          user_id: slackId("U", row.botUserId),
          bot_id: slackId("B", row.botUserId),
          app_id: slackId("A", row.id),
          is_enterprise_install: false,
        };
      },
    },

    "team.info": {
      async run({ app: row, teamId }) {
        const [workspace] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, row.workspaceId));
        return { team: { id: teamId, name: workspace?.name ?? "", domain: "chatter" } };
      },
    },

    "chat.postMessage": {
      scope: "chat:write",
      async run(ctx) {
        const { params } = ctx;
        // A user id posts to the bot's DM with that person, as in Slack.
        const channel = str(params.channel)?.startsWith("U")
          ? (await openDm(db, hub, ctx.app.workspaceId, ctx.app.botUserId, [...new Set([ctx.app.botUserId, (await workspaceUser(ctx, params.channel)).id])].sort())).channel
          : (await conversation(ctx, params.channel)).channel;
        const { text, blocks } = content(params, { required: true });
        const parent = params.thread_ts !== undefined && str(params.thread_ts) ? await threadParent(channel, params.thread_ts) : undefined;
        const result = await sendMessage(
          deps,
          channel.id,
          ctx.app.botUserId,
          {
            text: text!,
            blocks: blocks ?? undefined,
            parentId: parent?.id,
            alsoSendToChannel: parent !== undefined && flag(params.reply_broadcast),
            clientMsgId: randomUUID(),
            fileIds: [],
          },
          ctx.req.log,
        );
        if (result.kind === "rejected") throw new SlackError(result.error === "invalid_parent" ? "thread_not_found" : "invalid_arguments");
        const [slack] = await toMessages([result.message], ctx);
        return { channel: channelSlackId(channel), ts: messageTs(result.message), message: slack };
      },
    },

    "chat.update": {
      scope: "chat:write",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel);
        const row = await message(channel, ctx.params.ts);
        if (row.userId !== ctx.app.botUserId) throw new SlackError("cant_update_message");
        const { text, blocks } = content(ctx.params, { required: false });
        if (text === undefined && blocks === undefined) throw new SlackError("no_text");
        const updated = await editMessage(deps, row, { text: text ?? row.text, blocks });
        const [slack] = await toMessages([updated], ctx);
        return { channel: channelSlackId(channel), ts: messageTs(row), text: toSlackText(updated.text), message: slack };
      },
    },

    "chat.delete": {
      scope: "chat:write",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel);
        const row = await message(channel, ctx.params.ts);
        if (row.userId !== ctx.app.botUserId) throw new SlackError("cant_delete_message");
        await deleteMessage(deps, row);
        return { channel: channelSlackId(channel), ts: messageTs(row) };
      },
    },

    "chat.postEphemeral": {
      scope: "chat:write",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel);
        const user = await workspaceUser(ctx, ctx.params.user);
        if (!(await memberIds(db, channel.id)).includes(user.id)) throw new SlackError("user_not_in_channel");
        const { text, blocks } = content(ctx.params, { required: true });
        const parent = str(ctx.params.thread_ts) ? await threadParent(channel, ctx.params.thread_ts) : undefined;
        sendEphemeral(hub, user.id, { channelId: channel.id, parentId: parent?.id ?? null, author: await botAuthor(db, ctx.app), text: text!, blocks: blocks ?? undefined });
        return { message_ts: `${Math.floor(Date.now() / 1000)}.000000` };
      },
    },

    "conversations.info": {
      scope: "channels:read",
      async run(ctx) {
        const { channel, isMember } = await conversation(ctx, ctx.params.channel, { member: false });
        return { channel: slackChannel(channel, { teamId: ctx.teamId, viewerId: ctx.app.botUserId, isMember }) };
      },
    },

    "conversations.list": { scope: "channels:read", run: (ctx) => listConversations(ctx, { onlyMember: false }) },
    "users.conversations": { scope: "channels:read", run: (ctx) => listConversations(ctx, { onlyMember: true }) },

    "conversations.history": {
      scope: "channels:history",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel);
        const count = limitOf(ctx.params.limit, 100);
        const before = cursorOf(ctx.params.cursor);
        const latest = Number(str(ctx.params.latest));
        const oldest = Number(str(ctx.params.oldest));
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.channelId, channel.id),
              or(isNull(messages.parentId), eq(messages.alsoSentToChannel, true)),
              isNull(messages.deletedAt),
              before === undefined ? undefined : lt(messages.id, before),
              Number.isFinite(latest) && latest > 0 ? lt(messages.createdAt, new Date(latest * 1000)) : undefined,
              Number.isFinite(oldest) && oldest > 0 ? gt(messages.createdAt, new Date(oldest * 1000)) : undefined,
            ),
          )
          .orderBy(desc(messages.id))
          .limit(count + 1);
        const page = rows.slice(0, count);
        const hasMore = rows.length > count;
        return {
          messages: await toMessages(await loadMessages(db, page.map((r) => r.id)), ctx),
          has_more: hasMore,
          response_metadata: { next_cursor: hasMore ? String(page.at(-1)!.id) : "" },
        };
      },
    },

    "conversations.replies": {
      scope: "channels:history",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel);
        const parent = await threadParent(channel, ctx.params.ts);
        const count = limitOf(ctx.params.limit, PAGE_MAX);
        const after = cursorOf(ctx.params.cursor);
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.parentId, parent.id), isNull(messages.deletedAt), after === undefined ? undefined : gt(messages.id, after)))
          .orderBy(asc(messages.id))
          .limit(count + 1);
        const page = rows.slice(0, count);
        const hasMore = rows.length > count;
        // The thread's parent leads the first page, as in Slack.
        const ids = [...(after === undefined ? [parent.id] : []), ...page.map((r) => r.id)];
        return {
          messages: await toMessages(await loadMessages(db, ids), ctx),
          has_more: hasMore,
          response_metadata: { next_cursor: hasMore ? String(page.at(-1)!.id) : "" },
        };
      },
    },

    "conversations.open": {
      scope: "chat:write",
      async run(ctx) {
        const existing = str(ctx.params.channel);
        if (existing) {
          const { channel, isMember } = await conversation(ctx, existing);
          return { channel: slackChannel(channel, { teamId: ctx.teamId, viewerId: ctx.app.botUserId, isMember }), already_open: true };
        }
        const listed = (str(ctx.params.users) ?? "").split(",").map((u) => u.trim()).filter(Boolean);
        if (listed.length === 0 || listed.length > 8) throw new SlackError(listed.length === 0 ? "users_list_not_supplied" : "too_many_users");
        const people = await Promise.all(listed.map((u) => workspaceUser(ctx, u)));
        const ids = [...new Set([ctx.app.botUserId, ...people.map((p) => p.id)])].sort();
        const { channel, created } = await openDm(db, hub, ctx.app.workspaceId, ctx.app.botUserId, ids);
        return { channel: slackChannel(channel, { teamId: ctx.teamId, viewerId: ctx.app.botUserId, isMember: true }), ...(created ? {} : { already_open: true }) };
      },
    },

    "users.info": {
      scope: "users:read",
      async run(ctx) {
        return { user: slackUser(await workspaceUser(ctx, ctx.params.user), ctx.teamId) };
      },
    },

    "users.list": {
      scope: "users:read",
      async run(ctx) {
        const rows = await db
          .select({ id: users.id, displayName: users.displayName, kind: users.kind, timeZone: users.timeZone })
          .from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(eq(workspaceMembers.workspaceId, ctx.app.workspaceId))
          .orderBy(users.displayName);
        return { members: rows.map((r) => slackUser(r, ctx.teamId)), response_metadata: { next_cursor: "" } };
      },
    },

    "bots.info": {
      scope: "users:read",
      async run(ctx) {
        const userId = fromSlackId(ctx.params.bot, ["B"]);
        const user = userId ? await workspaceUser(ctx, slackId("U", userId)).catch(() => null) : null;
        if (!user || user.kind !== "bot") throw new SlackError("bot_not_found");
        const owner = await appByBot(db, user.id);
        return {
          bot: {
            id: slackId("B", user.id),
            deleted: false,
            name: user.displayName,
            updated: 0,
            user_id: slackId("U", user.id),
            ...(owner ? { app_id: slackId("A", owner.id) } : {}),
            icons: {},
          },
        };
      },
    },

    "reactions.add": { scope: "chat:write", run: (ctx) => react(ctx, true) },
    "reactions.remove": { scope: "chat:write", run: (ctx) => react(ctx, false) },

    // Chatter has no assistant panel: a status shows as the bot typing, the rest is accepted and ignored.
    "assistant.threads.setStatus": {
      scope: "chat:write",
      async run(ctx) {
        const { channel } = await conversation(ctx, ctx.params.channel_id);
        if (str(ctx.params.status)) {
          const parent = str(ctx.params.thread_ts) ? await threadParent(channel, ctx.params.thread_ts).catch(() => null) : null;
          const others = (await memberIds(db, channel.id)).filter((id) => id !== ctx.app.botUserId);
          hub.publish({ users: others }, { type: "typing", channelId: channel.id, parentId: parent?.id ?? null, userId: ctx.app.botUserId });
        }
        return {};
      },
    },
    "assistant.threads.setTitle": { scope: "chat:write", run: async () => ({}) },
    "assistant.threads.setSuggestedPrompts": { scope: "chat:write", run: async () => ({}) },
  };

  async function react(ctx: Ctx, add: boolean) {
    const { channel } = await conversation(ctx, ctx.params.channel);
    const emoji = emojiForName(ctx.params.name);
    if (!emoji) throw new SlackError("invalid_name");
    const row = await message(channel, ctx.params.timestamp);
    const [existing] = await db
      .select({ emoji: reactions.emoji })
      .from(reactions)
      .where(and(eq(reactions.messageId, row.id), eq(reactions.userId, ctx.app.botUserId), eq(reactions.emoji, emoji)));
    if (add && existing) throw new SlackError("already_reacted");
    if (!add && !existing) throw new SlackError("no_reaction");
    await setReaction(deps, row, ctx.app.botUserId, emoji, add);
    return {};
  }

  /** Public channels plus the conversations the bot is in, filtered by Slack `types`. */
  async function listConversations(ctx: Ctx, { onlyMember }: { onlyMember: boolean }) {
    const types = new Set((str(ctx.params.types) ?? "public_channel").split(",").map((t) => t.trim()));
    const rows = await db
      .select({ channel: channels, memberId: channelMembers.userId })
      .from(channels)
      .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, ctx.app.botUserId)))
      .where(and(eq(channels.workspaceId, ctx.app.workspaceId), onlyMember ? isNotNull(channelMembers.userId) : or(eq(channels.kind, "public"), isNotNull(channelMembers.userId))))
      .orderBy(channels.createdAt);
    const list = rows
      .map((r) => slackChannel(r.channel, { teamId: ctx.teamId, viewerId: ctx.app.botUserId, isMember: r.memberId !== null }))
      .filter((c) =>
        types.has(c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "private_channel" : "public_channel"),
      );
    return { channels: list, response_metadata: { next_cursor: "" } };
  }

  // Routes -------------------------------------------------------------------

  // Socket Mode: the app-level token buys a single-use WebSocket URL.
  const openConnection = async (req: FastifyRequest, params: Params) => {
    const token = tokenOf(req, params);
    if (!token) throw new SlackError("not_authed");
    const row = await appByAppToken(db, token);
    if (!row) throw new SlackError("invalid_auth");
    if (!row.socketMode) throw new SlackError("not_allowed_token_type");
    const ticket = await socketMode.issueTicket(row.id);
    return { url: `${origin(req).replace(/^http/, "ws")}/api/slack/socket?ticket=${encodeURIComponent(ticket)}` };
  };

  app.route({
    method: ["GET", "POST"],
    url: "/api/slack/:method",
    config: limit,
    handler: async (req, reply) => {
      const name = (req.params as { method: string }).method;
      const params = readParams(req);
      if (name === "apps.connections.open") return { ok: true, ...(await openConnection(req, params)) };
      const method = methods[name];
      const token = tokenOf(req, params);
      if (!token) throw new SlackError("not_authed");
      const row = await appByToken(db, token);
      if (!row) throw new SlackError("invalid_auth");
      reply.header("x-oauth-scopes", slackScopes(row)).header("x-accepted-oauth-scopes", method?.scope ? SLACK_SCOPES[method.scope][0]! : "");
      if (!method) throw new SlackError("unknown_method");
      if (method.scope && !row.scopes.includes(method.scope)) throw new SlackError("missing_scope", { needed: SLACK_SCOPES[method.scope][0], provided: slackScopes(row) });
      delete params.token;
      return { ok: true, ...(await method.run({ app: row, teamId: slackId("T", row.workspaceId), params, req })) };
    },
  });

  const socketApps = new WeakMap<FastifyRequest, AppRow>();
  app.get(
    "/api/slack/socket",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const ticket = str((req.query as Params).ticket);
        const appId = ticket ? await socketMode.redeemTicket(ticket) : null;
        const [row] = appId ? await db.select().from(apps).where(eq(apps.id, appId)) : [];
        if (!row || !row.socketMode) return reply.code(401).send({ ok: false, error: "invalid_auth" });
        if (socketMode.localConnections(row.id) >= MAX_CONNECTIONS_PER_APP) return reply.code(429).send({ ok: false, error: "too_many_websockets" });
        socketApps.set(req, row);
      },
    },
    (socket, req) => {
      const row = socketApps.get(req)!;
      socketMode.add(row.id, socket, { app_id: slackId("A", row.id) });
    },
  );

  // Late replies in Slack's shape (`text`, `blocks`, `response_type`, `replace_original`, `delete_original`).
  app.post("/api/slack/response/:token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const { reply: answer, deleteOriginal } = fromSlackReply(req.body);
    const redeemed = await redeemResponseUrl(db, token);
    if (!redeemed) return reply.code(404).send({ ok: false, error: "expired_url" });
    if (deleteOriginal && redeemed.target.messageId) {
      const [original] = await db.select().from(messages).where(eq(messages.id, redeemed.target.messageId));
      if (original && original.userId === redeemed.app.botUserId) await deleteMessage(deps, original);
    } else if (answer) {
      await applyReply(deps, redeemed.app, redeemed.target, answer, req.log);
    } else {
      throw new SlackError("no_text");
    }
    return { ok: true };
  });
}
