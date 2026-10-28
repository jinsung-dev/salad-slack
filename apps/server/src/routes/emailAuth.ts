import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { emailCodeStartInput, emailCodeVerifyInput } from "@chatter/shared";
import { startSession } from "../auth";
import type { AppDeps } from "../app";
import { emailCodes, users } from "../db/schema";
import { findLiveInvite } from "../invites";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const CODES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const hashCode = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest();

/**
 * Sign-in for outside guests, who have no account with the identity provider.
 * A code goes to an address only when an email-bound guest invite names it, or
 * when it already belongs to a guest account; people at the allowed (company)
 * domains always use the provider instead.
 */
export async function emailAuthRoutes(app: FastifyInstance, { db, mailer, allowedEmailDomains, cookieSecure, authRateLimit }: AppDeps) {
  const authLimit = { rateLimit: { max: authRateLimit, timeWindow: "1 minute" } };
  const isCompanyEmail = (email: string) => allowedEmailDomains.includes(email.split("@").at(-1)!);
  const accountFor = async (email: string) =>
    (await db.select({ id: users.id, guestOnly: users.guestOnly, kind: users.kind }).from(users).where(eq(users.email, email)))[0] ?? null;

  app.post("/api/auth/email/start", { config: authLimit }, async (req, reply) => {
    const { email, inviteToken } = emailCodeStartInput.parse(req.body);
    if (!mailer) return reply.code(503).send({ error: "email_login_disabled" });
    if (isCompanyEmail(email)) return reply.code(400).send({ error: "use_provider" });
    const account = await accountFor(email);

    if (inviteToken) {
      // The invite page already shows the invite to whoever holds the link, so its errors may be specific.
      const found = await findLiveInvite(db, inviteToken);
      if (!found) return reply.code(404).send({ error: "invite_invalid" });
      if (found.invite.role !== "guest" || found.invite.email !== email) return reply.code(400).send({ error: "invite_for_other_email" });
      if (account && !account.guestOnly) return reply.code(400).send({ error: "use_provider" });
    } else if (!account?.guestOnly) {
      // Without an invite the answer is the same whether or not the address has an account.
      return reply.code(204).send();
    }

    const recent = await db
      .select({ createdAt: emailCodes.createdAt })
      .from(emailCodes)
      .where(and(eq(emailCodes.email, email), gt(emailCodes.createdAt, new Date(Date.now() - 60 * 60 * 1000))))
      .orderBy(desc(emailCodes.createdAt));
    if (recent.length >= CODES_PER_HOUR || (recent[0] && Date.now() - recent[0].createdAt.getTime() < RESEND_AFTER_MS)) {
      return inviteToken ? reply.code(429).send({ error: "rate_limited" }) : reply.code(204).send();
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const id = randomUUID();
    await db.transaction(async (tx) => {
      // Only the newest code works.
      await tx.update(emailCodes).set({ usedAt: sql`now()` }).where(and(eq(emailCodes.email, email), isNull(emailCodes.usedAt)));
      await tx.insert(emailCodes).values({ id, email, codeHash: hashCode(id, code).toString("hex"), expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    });
    try {
      await mailer({
        to: email,
        subject: `Chatter 로그인 코드: ${code}`,
        text: `Chatter 로그인 코드는 ${code} 입니다.\n\n10분 동안 한 번만 쓸 수 있습니다. 요청한 적이 없다면 이 메일을 무시하세요.\n`,
      });
    } catch (err) {
      req.log.error({ err }, "sign-in code mail failed");
      await db.delete(emailCodes).where(eq(emailCodes.id, id));
      return reply.code(502).send({ error: "email_send_failed" });
    }
    return reply.code(204).send();
  });

  app.post("/api/auth/email/verify", { config: authLimit }, async (req, reply) => {
    const { email, code, displayName } = emailCodeVerifyInput.parse(req.body);
    const [pending] = await db
      .select()
      .from(emailCodes)
      .where(and(eq(emailCodes.email, email), isNull(emailCodes.usedAt), gt(emailCodes.expiresAt, new Date())))
      .orderBy(desc(emailCodes.createdAt))
      .limit(1);
    if (!pending || pending.attempts >= MAX_ATTEMPTS) return reply.code(400).send({ error: "code_expired" });

    if (!timingSafeEqual(hashCode(pending.id, code), Buffer.from(pending.codeHash, "hex"))) {
      await db.update(emailCodes).set({ attempts: sql`${emailCodes.attempts} + 1` }).where(eq(emailCodes.id, pending.id));
      return reply.code(400).send({ error: pending.attempts + 1 >= MAX_ATTEMPTS ? "code_expired" : "invalid_code" });
    }
    // Claim it atomically so the same code cannot sign in twice.
    const [claimed] = await db
      .update(emailCodes)
      .set({ usedAt: sql`now()` })
      .where(and(eq(emailCodes.id, pending.id), isNull(emailCodes.usedAt)))
      .returning({ id: emailCodes.id });
    if (!claimed) return reply.code(400).send({ error: "code_expired" });

    // A code exists only for a guest invite's address or a guest account, so a new account here is a guest's.
    let account = await accountFor(email);
    if (account && (!account.guestOnly || account.kind !== "person")) return reply.code(400).send({ error: "use_provider" });
    if (!account) {
      const [created] = await db
        .insert(users)
        .values({ email, displayName: displayName ?? email.split("@")[0]!, guestOnly: true })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, guestOnly: users.guestOnly, kind: users.kind });
      account = created ?? (await accountFor(email));
      if (!account?.guestOnly) return reply.code(400).send({ error: "use_provider" });
    }
    await startSession(db, reply, account.id, cookieSecure);
    return reply.code(204).send();
  });
}
