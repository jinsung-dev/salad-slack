import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull, lt, notInArray, sql } from "drizzle-orm";
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
import { files, mentions, messages, reactions } from "../db/schema";
import { mentionTargets, sendMessage } from "../messageService";
import { channelAccess, loadMessage, loadMessages, memberIds } from "../queries";

export async function messageRoutes(app: FastifyInstance, { db, hub, fileStore, push }: AppDeps) {
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

  const publishUpdated = async (id: number, members: string[]) => {
    const message = await loadMessage(db, id);
    if (message) hub.publish({ users: members }, { type: "message.updated", message });
  };

  app.post("/api/channels/:id/messages", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const input = postMessageInput.parse(req.body);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });

    const result = await sendMessage({ db, hub, push }, id, req.user!.id, input, req.log);
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

    const members = await memberIds(db, found.row.channelId);
    const mention = mentionTargets(text, members, me);
    await db.transaction(async (tx) => {
      await tx.update(messages).set({ text, editedAt: sql`now()`, mentionsChannel: mention.channel }).where(eq(messages.id, id));
      // Keep read state for people still mentioned; drop the rest.
      await tx
        .delete(mentions)
        .where(
          and(eq(mentions.messageId, id), mention.targets.length > 0 ? notInArray(mentions.userId, mention.targets) : undefined),
        );
      if (mention.targets.length > 0) {
        await tx
          .insert(mentions)
          .values(mention.targets.map((userId) => ({ messageId: id, userId, channelId: found.row.channelId })))
          .onConflictDoNothing();
      }
    });
    const message = (await loadMessage(db, id))!;
    hub.publish({ users: members }, { type: "message.updated", message });
    return message;
  });

  app.delete("/api/messages/:id", async (req, reply) => {
    const { id } = messageParams.parse(req.params);
    const me = req.user!.id;
    const found = await visibleMessage(id, me, reply);
    if (!found) return;
    if (found.row.userId !== me) return reply.code(403).send({ error: "not_author" });
    if (found.row.deletedAt) return reply.code(204).send();

    const parentId = found.row.parentId;
    let removedFiles: string[] = [];
    const parentGone = await db.transaction(async (tx) => {
      await tx.update(messages).set({ deletedAt: sql`now()`, text: "", mentionsChannel: false }).where(eq(messages.id, id));
      await tx.delete(mentions).where(eq(mentions.messageId, id));
      await tx.delete(reactions).where(eq(reactions.messageId, id));
      removedFiles = (await tx.delete(files).where(eq(files.messageId, id)).returning({ key: files.storageKey })).map((f) => f.key);
      if (parentId === null) return false;
      const [parent] = await tx
        .update(messages)
        .set({
          replyCount: sql`${messages.replyCount} - 1`,
          lastReplyAt: sql`(select max(created_at) from messages where parent_id = ${parentId} and deleted_at is null)`,
        })
        .where(eq(messages.id, parentId))
        .returning({ replyCount: messages.replyCount, deletedAt: messages.deletedAt });
      return parent!.replyCount === 0 && parent!.deletedAt !== null;
    });
    await fileStore.remove(removedFiles);

    const members = await memberIds(db, found.row.channelId);
    const channelId = found.row.channelId;
    if (parentId === null && found.row.replyCount > 0) {
      // Stays as a placeholder so its thread remains reachable.
      await publishUpdated(id, members);
    } else {
      hub.publish({ users: members }, { type: "message.deleted", channelId, id, parentId });
    }
    if (parentId !== null) {
      if (parentGone) hub.publish({ users: members }, { type: "message.deleted", channelId, id: parentId, parentId: null });
      else await publishUpdated(parentId, members);
    }
    return reply.code(204).send();
  });

  const react = (add: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id, emoji } = reactionParams.parse(req.params);
    const me = req.user!.id;
    const found = await visibleMessage(id, me, reply);
    if (!found) return;
    if (!found.isMember) return reply.code(403).send({ error: "not_a_member" });
    if (found.row.deletedAt) return reply.code(409).send({ error: "message_deleted" });

    if (add) await db.insert(reactions).values({ messageId: id, userId: me, emoji }).onConflictDoNothing();
    else
      await db
        .delete(reactions)
        .where(and(eq(reactions.messageId, id), eq(reactions.userId, me), eq(reactions.emoji, emoji)));

    const { reactions: list } = (await loadMessage(db, id))!;
    hub.publish(
      { users: await memberIds(db, found.row.channelId) },
      { type: "reaction.updated", channelId: found.row.channelId, messageId: id, reactions: list },
    );
    return list;
  };
  app.put("/api/messages/:id/reactions/:emoji", react(true));
  app.delete("/api/messages/:id/reactions/:emoji", react(false));
}

