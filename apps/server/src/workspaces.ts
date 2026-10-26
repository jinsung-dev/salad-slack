import type { FastifyReply } from "fastify";
import { and, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { GrantableRole, Member, WorkspaceRole } from "@chatter/shared";
import type { Db } from "./db/client";
import type { RealtimeHub } from "./realtime";
import { channelMembers, channels, users, workspaceMembers } from "./db/schema";

// Single owner of workspace membership and what each role may do.

const RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

export const atLeast = (role: WorkspaceRole, minimum: WorkspaceRole) => RANK[role] >= RANK[minimum];

export async function workspaceRole(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row?.role ?? null;
}

/**
 * The viewer's role when it is at least `minimum`. Otherwise sends 404 to
 * non-members (a workspace you are not in looks missing) or 403, and returns null.
 */
export async function requireRole(db: Db, reply: FastifyReply, workspaceId: string, userId: string, minimum: WorkspaceRole) {
  const role = await workspaceRole(db, workspaceId, userId);
  if (!role) {
    await reply.code(404).send({ error: "workspace_not_found" });
    return null;
  }
  if (!atLeast(role, minimum)) {
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return role;
}

/** People in the workspace; guests left out when `includeGuests` is false. */
export async function workspaceMemberIds(db: Db, workspaceId: string, { includeGuests = true } = {}): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), includeGuests ? undefined : ne(workspaceMembers.role, "guest")));
  return rows.map((r) => r.userId);
}

/** Everyone who shares at least one workspace with `userId`, themselves included: who may see their presence. */
export async function coMemberIds(db: Db, userId: string): Promise<string[]> {
  const { rows } = await db.execute<{ user_id: string }>(sql`
    select distinct theirs.user_id from workspace_members mine
    join workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = ${userId}`);
  return [...new Set([userId, ...rows.map((r) => r.user_id)])];
}

export async function memberView(db: Db, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ id: users.id, displayName: users.displayName, kind: users.kind, role: workspaceMembers.role, expiresAt: workspaceMembers.expiresAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row ? toMember(row) : null;
}

/** The Member view of a workspace membership row joined with its user. */
export function toMember(row: { id: string; displayName: string; kind: "person" | "bot"; role: WorkspaceRole; expiresAt: Date | null }): Member {
  return { id: row.id, displayName: row.displayName, role: row.role, isBot: row.kind === "bot", expiresAt: row.expiresAt?.toISOString() ?? null };
}

/** Adds someone to a workspace and tells its members; false when they already belonged. */
export async function addWorkspaceMember(
  db: Db,
  hub: RealtimeHub,
  workspaceId: string,
  userId: string,
  role: GrantableRole,
  expiresAt: Date | null = null,
): Promise<boolean> {
  const [added] = await db.insert(workspaceMembers).values({ workspaceId, userId, role, expiresAt }).onConflictDoNothing().returning();
  if (!added) return false;
  const member = await memberView(db, workspaceId, userId);
  if (member) hub.publish({ users: await workspaceMemberIds(db, workspaceId) }, { type: "member.joined", workspaceId, member });
  return true;
}

/**
 * Takes someone out of a workspace: their conversations there end with it.
 * The single path for leaving, removal by an admin and guest expiry; false
 * when they were already gone (another node got there first).
 */
export async function removeWorkspaceMember(db: Db, hub: RealtimeHub, workspaceId: string, userId: string): Promise<boolean> {
  const audience = await workspaceMemberIds(db, workspaceId);
  const removed = await db.transaction(async (tx) => {
    const inWorkspace = tx.select({ id: channels.id }).from(channels).where(eq(channels.workspaceId, workspaceId));
    await tx.delete(channelMembers).where(and(eq(channelMembers.userId, userId), inArray(channelMembers.channelId, inWorkspace)));
    return tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .returning({ userId: workspaceMembers.userId });
  });
  if (removed.length === 0) return false;
  hub.publish({ users: audience }, { type: "member.removed", workspaceId, userId });
  return true;
}

/** Removes memberships whose end date has passed. Run periodically on every node; safe to overlap. */
export async function expireMemberships(db: Db, hub: RealtimeHub, now = new Date()): Promise<number> {
  const due = await db
    .select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(isNotNull(workspaceMembers.expiresAt), lte(workspaceMembers.expiresAt, now)));
  let count = 0;
  for (const m of due) if (await removeWorkspaceMember(db, hub, m.workspaceId, m.userId)) count++;
  return count;
}
