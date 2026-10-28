import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { User } from "@chatter/shared";
import type { Db } from "./db/client";
import { sessions, users } from "./db/schema";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

/** Signs the browser in: a new session in its httpOnly cookie. */
export async function startSession(db: Db, reply: FastifyReply, userId: string, cookieSecure: boolean): Promise<void> {
  const token = await createSession(db, userId);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function findSessionUser(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName, guestOnly: users.guestOnly })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}
