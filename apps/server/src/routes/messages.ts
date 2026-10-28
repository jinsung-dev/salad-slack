import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  channelParams,
  editMessageInput,
  historyQuery,
  messageParams,
  postMessageInput,
  reactionParams,
  type MessagePage,
} from "@chatter/shared";
import type { AppDeps } from "../app";
import { messages } from "../db/schema";
import { deleteMessage, editMessage, sendMessage, setReaction } from "../messageService";
import { channelAccess, loadMessage, loadMessages } from "../queries";

export async function messageRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db } = deps;
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  /** The message and its channel when visible to `userId`, else a 404 is sent. */
  const visibleMessage = async (id: number, userId: string, reply: FastifyReply) => {
    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    const access = row ? await channelAccess(db, row.channelId, userId) : null;
    if (!row || !access || (row.deletedAt && row.replyCount === 0)) {
      await reply.code(404).send({ error: "message_not_found" });
      return null;
    }
    return { row, ...access };
  };

  app.post("/api/channels/:id/messages", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const input = postMessageInput.parse(req.body);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });

    const result = await sendMessage(deps, id, req.user!.id, input, req.log);
    if (result.kind === "rejected") return reply.code(result.error === "client_msg_id_reused" ? 409 : 400).send({ error: result.error });
    return reply.code(result.kind === "created" ? 201 : 200).send(result.message);
  });

  app.get("/api/messages/:id", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    if (!(await visibleMessage(id, req.user!.id, reply))) return;
    return loadMessage(db, id);
  });

  app.get("/api/messages/:id/replies", async (req, reply): Promise<MessagePage | undefined> => {
    const { id } = messageParams.parse(req.params);
    const { before, limit } = historyQuery.parse(req.query);
    if (!(await visibleMessage(id, req.user!.id, reply))) return;
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.parentId, id), isNull(messages.deletedAt), before === undefined ? undefined : lt(messages.id, before)))
      .orderBy(desc(messages.id))
      .limit(limit + 1);
    const ids = rows.slice(0, limit).map((r) => r.id).reverse();
    return { messages: await loadMessages(db, ids), hasMore: rows.length > limit };
  });

  app.post("/api/messages/:id/thread/read", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    const me = req.user!.id;
    if (!(await visibleMessage(id, me, reply))) return;
    await db.execute(sql`
      update mentions mn set read_at = now()
      from messages m
      where mn.message_id = m.id and mn.user_id = ${me} and mn.read_at is null
        and (m.id = ${id} or m.parent_id = ${id})`);
    return reply.code(204).send();
  });

  app.patch("/api/messages/:id", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    const { text } = editMessageInput.parse(req.body);
    const me = req.user!.id;
    const found = await visibleMessage(id, me, reply);
    if (!found) return;
    if (found.row.userId !== me) return reply.code(403).send({ error: "not_author" });
    if (found.row.deletedAt) return reply.code(409).send({ error: "message_deleted" });
    return editMessage(deps, found.row, { text });
  });

  app.delete("/api/messages/:id", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    const me = req.user!.id;
    const found = await visibleMessage(id, me, reply);
    if (!found) return;
    if (found.row.userId !== me) return reply.code(403).send({ error: "not_author" });
    await deleteMessage(deps, found.row);
    return reply.code(204).send();
  });

  const react = (add: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, emoji } = reactionParams.parse(req.params);
    const me = req.user!.id;
    const found = await visibleMessage(id, me, reply);
    if (!found) return;
    if (!found.isMember) return reply.code(403).send({ error: "not_a_member" });
    if (found.row.deletedAt) return reply.code(409).send({ error: "message_deleted" });
    return setReaction(deps, found.row, me, emoji, add);
  };
  app.put("/api/messages/:id/reactions/:emoji", react(true));
  app.delete("/api/messages/:id/reactions/:emoji", react(false));
}

