import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { createInviteInput, workspaceParams, type Invite, type InvitePreview } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { channels, invites, users, workspaces } from "../db/schema";
import { addChannelMembers, channelAccess, channelSummary } from "../queries";
import { addWorkspaceMember, requireRole, workspaceRole } from "../workspaces";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const inviteParams = workspaceParams.extend({ inviteId: z.uuid() });
const tokenParams = z.object({ token: z.string().min(16).max(128) });

type InviteRow = typeof invites.$inferSelect;
const toInvite = (row: InviteRow): Invite => ({
  id: row.id,
  role: row.role,
  email: row.email,
  channelId: row.channelId,
  guestDays: row.guestDays,
  expiresAt: row.expiresAt.toISOString(),
  usedAt: row.usedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

export async function inviteRoutes(app: FastifyInstance, { db, hub, publicUrl }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  const origin = (req: FastifyRequest) => publicUrl ?? `${req.protocol}://${req.host}`;

  // Admins hand out invites; the link (shown once) carries the only copy of the token.
  // A channel invite also needs the admin in that channel: they bring people where they are.
  app.post("/api/workspaces/:workspaceId/invites", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const { role, email, channelId, guestDays } = createInviteInput.parse(req.body ?? {});
    const myRole = await requireRole(db, reply, workspaceId, req.user!.id, "admin");
    if (!myRole) return;
    if (role === "admin" && myRole !== "owner") return reply.code(403).send({ error: "forbidden" });
    if (channelId) {
      const access = await channelAccess(db, channelId, req.user!.id);
      if (!access || access.channel.workspaceId !== workspaceId || access.channel.kind === "dm" || !access.isMember) {
        return reply.code(400).send({ error: "invalid_channel" });
      }
    }
    const token = randomBytes(24).toString("base64url");
    const [row] = await db
      .insert(invites)
      .values({
        workspaceId,
        tokenHash: hashToken(token),
        role,
        email,
        channelId,
        guestDays,
        createdBy: req.user!.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    return reply.code(201).send({ ...toInvite(row!), url: `${origin(req)}/invite/${token}` } satisfies Invite);
  });

  app.get("/api/workspaces/:workspaceId/invites", async (req, reply): Promise<Invite[] | undefined> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const rows = await db.select().from(invites).where(eq(invites.workspaceId, workspaceId)).orderBy(desc(invites.createdAt));
    return rows.map(toInvite);
  });

  app.delete("/api/workspaces/:workspaceId/invites/:inviteId", async (req, reply) => {
    const { workspaceId, inviteId } = inviteParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    await db
      .update(invites)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, workspaceId), isNull(invites.revokedAt)));
    return reply.code(204).send();
  });

  /** A live invite for this token, or null: unknown, expired, revoked and used look the same. */
  const liveInvite = async (token: string) => {
    const [row] = await db
      .select({ invite: invites, workspaceName: workspaces.name, inviter: users.displayName, channelName: channels.name })
      .from(invites)
      .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
      .innerJoin(users, eq(users.id, invites.createdBy))
      .leftJoin(channels, eq(channels.id, invites.channelId))
      .where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.revokedAt), isNull(invites.usedAt), gt(invites.expiresAt, new Date())));
    return row ?? null;
  };

  app.get("/api/invites/:token", async (req, reply): Promise<InvitePreview | undefined> => {
    const { token } = tokenParams.parse(req.params);
    const found = await liveInvite(token);
    if (!found) return reply.code(404).send({ error: "invite_invalid" });
    return {
      workspace: { id: found.invite.workspaceId, name: found.workspaceName },
      channel: found.invite.channelId && found.channelName ? { id: found.invite.channelId, name: found.channelName } : null,
      inviter: found.inviter,
      role: found.invite.role,
      email: found.invite.email,
      guestDays: found.invite.guestDays,
      expiresAt: found.invite.expiresAt.toISOString(),
      alreadyMember: (await workspaceRole(db, found.invite.workspaceId, req.user!.id)) !== null,
    };
  });

  // An email-bound invite works once, for that address only; others are reusable until they expire.
  app.post("/api/invites/:token/accept", async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const found = await liveInvite(token);
    if (!found) return reply.code(404).send({ error: "invite_invalid" });
    const { invite } = found;
    if (invite.email && invite.email !== req.user!.email.toLowerCase()) return reply.code(403).send({ error: "invite_for_other_email" });
    if (invite.email) {
      // Claim it atomically so two accepts cannot both use a single-use link.
      const [claimed] = await db
        .update(invites)
        .set({ usedAt: sql`now()` })
        .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
        .returning({ id: invites.id });
      if (!claimed) return reply.code(404).send({ error: "invite_invalid" });
    }
    const me = req.user!.id;
    const ends = invite.role === "guest" && invite.guestDays ? new Date(Date.now() + invite.guestDays * DAY_MS) : null;
    // Someone already in the workspace keeps their role; a channel invite still adds them to the channel.
    await addWorkspaceMember(db, hub, invite.workspaceId, me, invite.role, ends);
    if (invite.channelId) {
      const [channel] = await db.select().from(channels).where(eq(channels.id, invite.channelId));
      if (channel && (await addChannelMembers(db, channel.id, channel.workspaceId, [me])).length > 0) {
        hub.publish({ users: [me] }, { type: "channel.added", channel: await channelSummary(db, channel), isMember: true });
      }
    }
    return { workspaceId: invite.workspaceId, channelId: invite.channelId };
  });
}
