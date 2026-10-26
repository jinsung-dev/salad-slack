import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { botHistoryQuery, botPostMessageInput, type AppScope, type Channel, type Member, type MessagePage } from "@chatter/shared";
import type { AppDeps } from "../app";
import { appByToken, hasScope, type AppRow } from "../apps";
import { messages, users, workspaceMembers } from "../db/schema";
import { sendMessage } from "../messageService";
import { channelAccess, listChannels, loadMessages } from "../queries";
import { toMember } from "../workspaces";

declare module "fastify" {
  interface FastifyRequest {
    botApp?: AppRow;
  }
}

/**
 * The bot API, authenticated by `Authorization: Bearer <bot token>`. A bot
 * acts only in conversations it was added to, within its scopes.
 */
export async function botApiRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.botApp?.id ?? req.ip } };

  app.decorateRequest("botApp", undefined);
  app.addHook("onRequest", async (req, reply) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    const found = token ? await appByToken(db, token) : null;
    if (!found) return reply.code(401).send({ error: "invalid_token" });
    req.botApp = found;
  });

  const need = async (req: FastifyRequest, reply: FastifyReply, scope: AppScope) => {
    if (hasScope(req.botApp!, scope)) return true;
    await reply.code(403).send({ error: "missing_scope", needed: scope });
    return false;
  };
  /** The channel when the bot is in it; otherwise a 404 is sent. */
  const botChannel = async (req: FastifyRequest, reply: FastifyReply, channelId: string) => {
    const access = await channelAccess(db, channelId, req.botApp!.botUserId);
    if (!access?.isMember) {
      await reply.code(404).send({ error: "channel_not_found" });
      return null;
    }
    return access.channel;
  };

  app.get("/api/bot/v1/auth.test", { config: limit }, async (req) => ({
    appId: req.botApp!.id,
    botUserId: req.botApp!.botUserId,
    workspaceId: req.botApp!.workspaceId,
    scopes: req.botApp!.scopes,
  }));

  app.post("/api/bot/v1/chat.postMessage", { config: limit }, async (req, reply) => {
    if (!(await need(req, reply, "chat:write"))) return;
    const input = botPostMessageInput.parse(req.body);
    if (!(await botChannel(req, reply, input.channelId))) return;
    const result = await sendMessage(
      deps,
      input.channelId,
      req.botApp!.botUserId,
      { text: input.text, blocks: input.blocks, parentId: input.parentId, clientMsgId: randomUUID(), alsoSendToChannel: false, fileIds: [] },
      req.log,
    );
    if (result.kind === "rejected") return reply.code(400).send({ error: result.error });
    return reply.code(201).send(result.message);
  });

  // Conversations the bot can see: public channels and the ones it was added to.
  app.get("/api/bot/v1/conversations.list", { config: limit }, async (req, reply): Promise<Channel[] | undefined> => {
    if (!(await need(req, reply, "channels:read"))) return;
    return listChannels(db, req.botApp!.botUserId, req.botApp!.workspaceId);
  });

  app.get("/api/bot/v1/conversations.history", { config: limit }, async (req, reply): Promise<MessagePage | undefined> => {
    if (!(await need(req, reply, "channels:history"))) return;
    const { channelId, before, limit: count } = botHistoryQuery.parse(req.query);
    if (!(await botChannel(req, reply, channelId))) return;
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          or(isNull(messages.parentId), eq(messages.alsoSentToChannel, true)),
          isNull(messages.deletedAt),
          before === undefined ? undefined : lt(messages.id, before),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(count + 1);
    return { messages: await loadMessages(db, rows.slice(0, count).map((r) => r.id).reverse()), hasMore: rows.length > count };
  });

  app.get("/api/bot/v1/users.list", { config: limit }, async (req, reply): Promise<Member[] | undefined> => {
    if (!(await need(req, reply, "users:read"))) return;
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, kind: users.kind, role: workspaceMembers.role, expiresAt: workspaceMembers.expiresAt })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, req.botApp!.workspaceId))
      .orderBy(sql`${users.displayName}`);
    return rows.map(toMember);
  });
}
