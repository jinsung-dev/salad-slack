import type { FastifyInstance } from "fastify";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  channelParams,
  createChannelInput,
  createDmInput,
  historyQuery,
  inviteInput,
  markReadInput,
  notifyInput,
  workspaceParams,
  type MessagePage,
} from "@chatter/shared";
import type { AppDeps } from "../app";
import { channelMembers, channels, messages } from "../db/schema";
import { addChannelMembers, channelAccess, channelFor, channelSummary, listChannels, loadMessages, openDm } from "../queries";
import { requireRole, workspaceMemberIds } from "../workspaces";

export async function channelRoutes(app: FastifyInstance, { db, hub }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  app.get("/api/workspaces/:workspaceId/channels", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "guest"))) return;
    return listChannels(db, req.user!.id, workspaceId);
  });

  // Members and above create channels; guests only join what they are invited to.
  app.post("/api/workspaces/:workspaceId/channels", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const input = createChannelInput.parse(req.body);
    const me = req.user!.id;
    if (!(await requireRole(db, reply, workspaceId, me, "member"))) return;
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(channels)
        .values({ workspaceId, kind: input.isPrivate ? "private" : "public", name: input.name, topic: input.topic, createdBy: me })
        .onConflictDoNothing({ target: [channels.workspaceId, channels.name] })
        .returning();
      if (row) await tx.insert(channelMembers).values({ channelId: row.id, userId: me });
      return row;
    });
    if (!created) return reply.code(409).send({ error: "channel_name_taken" });

    const summary = await channelSummary(db, created);
    hub.publish({ users: [me] }, { type: "channel.added", channel: summary, isMember: true });
    if (created.kind === "public") {
      const others = (await workspaceMemberIds(db, workspaceId, { includeGuests: false })).filter((id) => id !== me);
      hub.publish({ users: others }, { type: "channel.added", channel: summary, isMember: false });
    }
    return reply.code(201).send(await channelFor(db, me, created.id));
  });

  // One conversation per set of people in a workspace: asking again returns the same DM.
  app.post("/api/workspaces/:workspaceId/dms", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const me = req.user!.id;
    if (!(await requireRole(db, reply, workspaceId, me, "member"))) return;
    const ids = [...new Set([me, ...createDmInput.parse(req.body).userIds])].sort();
    const inWorkspace = new Set(await workspaceMemberIds(db, workspaceId));
    if (!ids.every((id) => inWorkspace.has(id))) return reply.code(400).send({ error: "unknown_user" });

    const { channel, created } = await openDm(db, hub, workspaceId, me, ids);
    return reply.code(created ? 201 : 200).send(await channelFor(db, me, channel.id));
  });

  // One conversation the viewer can see, with its workspace: resolves links that carry only a channel id.
  app.get("/api/channels/:id", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    if (!(await channelAccess(db, id, req.user!.id))) return reply.code(404).send({ error: "channel_not_found" });
    return channelFor(db, req.user!.id, id);
  });

  app.post("/api/channels/:id/join", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (access.channel.kind !== "public") return reply.code(403).send({ error: "invite_only" });
    await addChannelMembers(db, id, access.channel.workspaceId, [req.user!.id]);
    hub.publish({ users: [req.user!.id] }, { type: "channel.added", channel: await channelSummary(db, access.channel), isMember: true });
    return reply.code(204).send();
  });

  // Members of a channel add others from the same workspace; guests cannot add anyone.
  app.post("/api/channels/:id/members", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const { userIds } = inviteInput.parse(req.body);
    const access = await channelAccess(db, id, req.user!.id);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (!access.isMember || access.role === "guest") return reply.code(403).send({ error: "not_allowed" });
    if (access.channel.kind === "dm") return reply.code(400).send({ error: "dm_members_fixed" });
    const inWorkspace = new Set(await workspaceMemberIds(db, access.channel.workspaceId));
    if (!userIds.every((u) => inWorkspace.has(u))) return reply.code(400).send({ error: "unknown_user" });

    const added = await addChannelMembers(db, id, access.channel.workspaceId, userIds);
    hub.publish({ users: added }, { type: "channel.added", channel: await channelSummary(db, access.channel), isMember: true });
    return reply.code(204).send();
  });

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

  app.put("/api/channels/:id/notify", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const { level } = notifyInput.parse(req.body);
    const updated = await db
      .update(channelMembers)
      .set({ notify: level })
      .where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, req.user!.id)))
      .returning({ channelId: channelMembers.channelId });
    if (updated.length === 0) return reply.code(403).send({ error: "not_a_member" });
    return reply.code(204).send();
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
