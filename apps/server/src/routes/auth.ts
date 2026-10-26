import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { SESSION_COOKIE, SESSION_TTL_MS, createSession, deleteSession } from "../auth";
import type { AppDeps } from "../app";
import { users } from "../db/schema";
import type { PendingLogin, VerifiedIdentity } from "../oidc";

const LOGIN_COOKIE = "oidc_login";
const LOGIN_TTL_S = 10 * 60;
const CALLBACK_PATH = "/api/auth/oidc/callback";

/** A same-origin path to return to after sign-in; anything else falls back to the home page. */
const safeReturnPath = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && value.length <= 512 ? value : "/";

export async function authRoutes(app: FastifyInstance, { db, oidc, publicUrl, cookieSecure, authRateLimit }: AppDeps) {
  // Per client IP: generous for people, tight for scripted abuse.
  const authLimit = { rateLimit: { max: authRateLimit, timeWindow: "1 minute" } };

  /** The configured public origin, else the one this request came in on (local development). */
  const origin = (req: FastifyRequest) => publicUrl ?? `${req.protocol}://${req.host}`;
  const failed = (reply: FastifyReply, code: string) => reply.redirect(`/login?error=${code}`);

  app.get("/api/auth/oidc/start", { config: authLimit }, async (req, reply) => {
    const { url, pending } = await oidc.start(`${origin(req)}${CALLBACK_PATH}`);
    const returnTo = safeReturnPath((req.query as { returnTo?: unknown }).returnTo);
    reply.setCookie(LOGIN_COOKIE, Buffer.from(JSON.stringify({ ...pending, returnTo })).toString("base64url"), {
      httpOnly: true,
      // Lax so the cookie comes back on the provider's top-level redirect.
      sameSite: "lax",
      secure: cookieSecure,
      path: "/api/auth/oidc",
      maxAge: LOGIN_TTL_S,
    });
    return reply.redirect(url.href);
  });

  app.get(CALLBACK_PATH, { config: authLimit }, async (req, reply) => {
    const raw = req.cookies[LOGIN_COOKIE];
    reply.clearCookie(LOGIN_COOKIE, { path: "/api/auth/oidc" });
    let pending: PendingLogin & { returnTo?: string };
    try {
      pending = JSON.parse(Buffer.from(raw ?? "", "base64url").toString("utf8")) as PendingLogin & { returnTo?: string };
      if (!pending.verifier || !pending.state || !pending.nonce) throw new Error("incomplete");
    } catch {
      return failed(reply, "login_expired");
    }

    const identity = await oidc.finish(new URL(req.url, origin(req)), pending);
    if (typeof identity === "string") return failed(reply, identity);

    const userId = await findOrCreateUser(identity);
    if (!userId) return failed(reply, "account_conflict");
    const token = await createSession(db, userId);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return reply.redirect(safeReturnPath(pending.returnTo));
  });

  /**
   * The account for this provider subject. A first sign-in links an unlinked
   * account with the same verified email, or creates one. An email already
   * linked to another subject (e.g. a recreated Google account) is a conflict.
   */
  const findOrCreateUser = async (identity: VerifiedIdentity): Promise<string | null> => {
    const [bySubject] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.oidcIssuer, identity.issuer), eq(users.oidcSubject, identity.subject)));
    if (bySubject) return bySubject.id;

    const [linked] = await db
      .update(users)
      .set({ oidcIssuer: identity.issuer, oidcSubject: identity.subject })
      .where(and(eq(users.email, identity.email), isNull(users.oidcSubject)))
      .returning({ id: users.id });
    if (linked) return linked.id;

    const [created] = await db
      .insert(users)
      .values({ email: identity.email, displayName: identity.name, oidcIssuer: identity.issuer, oidcSubject: identity.subject })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, displayName: users.displayName });
    return created?.id ?? null;
  };

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    return req.user;
  });
}
