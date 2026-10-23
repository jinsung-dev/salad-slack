import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { messageParams, type MessagePage } from "@chatter/shared";
import type { AppDeps } from "../app";
import { messages, savedMessages } from "../db/schema";
import { channelAccess, loadMessages } from "../queries";

const SAVED_LIMIT = 200;

export async function savedRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  app.put("/api/messages/:id/save", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    const me = req.user!.id;
    const [row] = await db.select({ channelId: messages.channelId, deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    if (!row || row.deletedAt || !(await channelAccess(db, row.channelId, me))) return reply.code(404).send({ error: "message_not_found" });
    await db.insert(savedMessages).values({ userId: me, messageId: id }).onConflictDoNothing();
    return reply.code(204).send();
  });

  app.delete("/api/messages/:id/save", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    await db.delete(savedMessages).where(and(eq(savedMessages.userId, req.user!.id), eq(savedMessages.messageId, id)));
    return reply.code(204).send();
  });

  // Most recently saved first, up to SAVED_LIMIT. Messages since deleted, or in
  // conversations the viewer can no longer read, are left out.
  app.get("/api/saved", async (req): Promise<MessagePage> => {
    const me = req.user!.id;
    const { rows } = await db.execute<{ message_id: string }>(sql`
      select s.message_id
      from saved_messages s
      join messages m on m.id = s.message_id
      join channels c on c.id = m.channel_id
      left join channel_members cm on cm.channel_id = c.id and cm.user_id = ${me}
      where s.user_id = ${me} and m.deleted_at is null and (c.kind = 'public' or cm.user_id is not null)
      order by s.saved_at desc, s.message_id desc
      limit ${SAVED_LIMIT + 1}`);
    return { messages: await loadMessages(db, rows.slice(0, SAVED_LIMIT).map((r) => Number(r.message_id))), hasMore: rows.length > SAVED_LIMIT };
  });
}
