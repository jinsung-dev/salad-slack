import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { channelParams, createChannelInput, createDmInput, historyQuery, inviteInput, markReadInput, type MessagePage } from "@chatter/shared";
import type { AppDeps } from "../app";
import { channelMembers, channels, messages, users } from "../db/schema";
import { channelAccess, channelFor, channelSummary, listChannels, loadMessages } from "../queries";

export async function channelRoutes(app: FastifyInstance, { db, hub }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  app.get("/api/channels", async (req) => listChannels(db, req.user!.id));

  app.post("/api/channels", async (req, reply) => {
    const input = createChannelInput.parse(req.body);
    const me = req.user!.id;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(channels)
        .values({ kind: input.isPrivate ? "private" : "public", name: input.name, topic: input.topic, createdBy: me })
        .onConflictDoNothing({ target: channels.name })
        .returning();
      if (row) await tx.insert(channelMembers).values({ channelId: row.id, userId: me });
      return row;
    });
    if (!created) return reply.code(409).send({ error: "channel_name_taken" });

    const summary = await channelSummary(db, created);
    hub.publish({ users: [me] }, { type: "channel.added", channel: summary, isMember: true });
    if (created.kind === "public") hub.publish({ all: true, except: [me] }, { type: "channel.added", channel: summary, isMember: false });
    return reply.code(201).send(await channelFor(db, me, created.id));
  });

  // One conversation per set of people: asking again returns the same DM.
  app.post("/api/dms", async (req, reply) => {
    const me = req.user!.id;
    const ids = [...new Set([me, ...createDmInput.parse(req.body).userIds])].sort();
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (found.length !== ids.length) return reply.code(400).send({ error: "unknown_user" });

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(channels)
        .values({ kind: "dm", dmKey: ids.join(","), createdBy: me })
        .onConflictDoNothing({ target: channels.dmKey })
        .returning();
      if (row) await tx.insert(channelMembers).values(ids.map((userId) => ({ channelId: row.id, userId })));
      return row;
    });
    if (created) {
      hub.publish({ users: ids }, { type: "channel.added", channel: await channelSummary(db, created), isMember: true });
    }
    const [existing] = await db.select({ id: channels.id }).from(channels).where(eq(channels.dmKey, ids.join(",")));
    return reply.code(created ? 201 : 200).send(await channelFor(db, me, existing!.id));
  });

  app.post("/api/channels/:id/join", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (access.channel.kind !== "public") return reply.code(403).send({ error: "invite_only" });
    await addMembers(id, [req.user!.id]);
    hub.publish({ users: [req.user!.id] }, { type: "channel.added", channel: await channelSummary(db, access.channel), isMember: true });
    return reply.code(204).send();
  });

  app.post("/api/channels/:id/members", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const { userIds } = inviteInput.parse(req.body);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });
    if (access.channel.kind === "dm") return reply.code(400).send({ error: "dm_members_fixed" });
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
    if (found.length !== new Set(userIds).size) return reply.code(400).send({ error: "unknown_user" });

    const added = await addMembers(id, userIds);
    hub.publish({ users: added }, { type: "channel.added", channel: await channelSummary(db, access.channel), isMember: true });
    return reply.code(204).send();
  });

  /** Adds members with existing history marked read; returns who was newly added. */
  const addMembers = async (channelId: string, userIds: string[]) => {
    const { rows } = await db.execute<{ user_id: string }>(sql`
      insert into channel_members (channel_id, user_id, last_read_message_id)
      select ${channelId}, u.id, (select coalesce(max(id), 0) from messages where channel_id = ${channelId})
      from users u where u.id in ${userIds}
      on conflict do nothing
      returning user_id`);
    return rows.map((r) => r.user_id);
  };

  // Public channels are readable before joining, like a preview.
  app.get("/api/channels/:id/messages", async (req, reply): Promise<MessagePage> => {
    const { id } = channelParams.parse(req.params);
    const { before, limit } = historyQuery.parse(req.query);
    if (!(await channelAccess(db, id, req.user!.id))) return reply.code(404).send({ error: "channel_not_found" });
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, id),
          or(sql`${messages.parentId} is null`, eq(messages.alsoSentToChannel, true)),
          // A deleted message stays only as a placeholder for its thread.
          sql`(${messages.deletedAt} is null or ${messages.replyCount} > 0)`,
          before === undefined ? undefined : lt(messages.id, before),
        ),
      )
      .orderBy(desc(messages.id))
      .limit(limit + 1);
    const ids = rows.slice(0, limit).map((r) => r.id).reverse();
    return { messages: await loadMessages(db, ids), hasMore: rows.length > limit };
  });

  app.post("/api/channels/:id/read", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const { messageId } = markReadInput.parse(req.body);
    const me = req.user!.id;
    const result = await db
      .update(channelMembers)
      .set({ lastReadMessageId: sql`greatest(${channelMembers.lastReadMessageId}, ${messageId})` })
      .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, me)))
      .returning({ channelId: channelMembers.channelId });
    if (result.length === 0) return reply.code(403).send({ error: "not_a_member" });
    // Mentions inside threads stay unread until the thread itself is read.
    await db.execute(sql`
      update mentions mn set read_at = now()
      from messages m
      where mn.message_id = m.id and mn.user_id = ${me} and mn.channel_id = ${id} and mn.read_at is null
        and m.id <= ${messageId} and (m.parent_id is null or m.also_sent_to_channel)`);
    return reply.code(204).send();
  });
}
