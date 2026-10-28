import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "./db/client";
import { channels, invites, users, workspaces } from "./db/schema";

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A live invite for this link token, or null: unknown, expired, revoked and used look the same. */
export async function findLiveInvite(db: Db, token: string) {
  const [row] = await db
    .select({ invite: invites, workspaceName: workspaces.name, inviter: users.displayName, channelName: channels.name })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .innerJoin(users, eq(users.id, invites.createdBy))
    .leftJoin(channels, eq(channels.id, invites.channelId))
    .where(and(eq(invites.tokenHash, hashInviteToken(token)), isNull(invites.revokedAt), isNull(invites.usedAt), gt(invites.expiresAt, new Date())));
  return row ?? null;
}
