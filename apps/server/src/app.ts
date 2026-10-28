import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { User } from "@chatter/shared";
import { SESSION_COOKIE, findSessionUser } from "./auth";
import type { Db } from "./db/client";
import { FileStore } from "./files";
import type { Mailer } from "./mail";
import type { PushSender } from "./notify";
import type { OutboundPolicy } from "./outbound";
import { Oidc, type OidcConfig } from "./oidc";
import { channelAccess, memberIds } from "./queries";
import { coMemberIds, expireMemberships } from "./workspaces";
import { RealtimeHub } from "./realtime";
import { SocketModeHub } from "./slack/socket";
import { authRoutes } from "./routes/auth";
import { emailAuthRoutes } from "./routes/emailAuth";
import { channelRoutes } from "./routes/channels";
import { fileRoutes } from "./routes/files";
import { messageRoutes } from "./routes/messages";
import { pushRoutes } from "./routes/push";
import { savedRoutes } from "./routes/saved";
import { inviteRoutes } from "./routes/invites";
import { webhookRoutes } from "./routes/webhooks";
import { appRoutes } from "./routes/apps";
import { botApiRoutes } from "./routes/botApi";
import { interactionRoutes } from "./routes/interactions";
import { slackApiRoutes } from "./routes/slackApi";
import { workspaceRoutes } from "./routes/workspaces";
import { searchRoutes } from "./routes/search";
import { userRoutes } from "./routes/users";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppDeps {
  db: Db;
  hub: RealtimeHub;
  oidc: Oidc;
  /** Public origin for sign-in redirects; derived from each request when unset. */
  publicUrl: string | undefined;
  cookieSecure: boolean;
  /** Sign-in attempts per client IP per minute. */
  authRateLimit: number;
  /** Company domains: they sign in through the provider, never with an emailed code. */
  allowedEmailDomains: string[];
  /** Sends guests their sign-in codes; null disables email sign-in. */
  mailer: Mailer | null;
  fileStore: FileStore;
  maxFileBytes: number;
  /** Web Push; null when no VAPID keys are configured. */
  push: { publicKey: string; send: PushSender } | null;
  /** How requests to app URLs are restricted. */
  outbound: OutboundPolicy;
  /** Socket Mode connections of apps (Slack protocol), across nodes. */
  socketMode: SocketModeHub;
}

/** One typing event per user and conversation in this window is relayed; the rest are dropped. */
const TYPING_THROTTLE_MS = 2_000;

export async function buildApp({
  db,
  redisUrl,
  redisPrefix,
  oidc,
  publicUrl,
  cookieSecure,
  allowedEmailDomains = [],
  authRateLimit = 10,
  webDist,
  fileStorageDir,
  maxFileBytes = 25 * 1024 * 1024,
  push = null,
  mailer = null,
  allowPrivateAppUrls = false,
  trustProxy = false,
  logger = true,
}: {
  db: Db;
  redisUrl: string;
  redisPrefix: string;
  oidc: OidcConfig;
  publicUrl?: string;
  cookieSecure: boolean;
  /** Lowercase Google Workspace domains allowed to sign in; empty allows any verified account. */
  allowedEmailDomains?: string[];
  authRateLimit?: number;
  /** Directory of the built web app to serve; skipped when it has no index.html. */
  webDist?: string;
  /** Where attachment bytes are written. */
  fileStorageDir: string;
  maxFileBytes?: number;
  push?: AppDeps["push"];
  mailer?: Mailer | null;
  /** Tests and local development only: apps may use plain HTTP and private addresses. */
  allowPrivateAppUrls?: boolean;
  /** Trust X-Forwarded-* from a reverse proxy, so rate limits key on the real client. */
  trustProxy?: boolean;
  logger?: boolean;
}) {
  const app = Fastify({ logger, trustProxy });
  const hub = await RealtimeHub.start(redisUrl, redisPrefix, (msg, err) => app.log.error({ err }, msg));
  app.addHook("onClose", async () => hub.close());
  const socketMode = await SocketModeHub.start(redisUrl, redisPrefix, (msg, err) => app.log.error({ err }, msg));
  app.addHook("onClose", async () => socketMode.close());
  const deps: AppDeps = {
    db,
    hub,
    oidc: new Oidc(oidc, allowedEmailDomains),
    publicUrl,
    cookieSecure,
    authRateLimit,
    allowedEmailDomains,
    mailer,
    fileStore: new FileStore(fileStorageDir),
    maxFileBytes,
    push,
    outbound: { allowPrivate: allowPrivateAppUrls },
    socketMode,
  };

  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart);
  // Opt-in per route (sign-in). Counts are per node.
  await app.register(rateLimit, { global: false });

  app.get("/api/health", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  if (webDist && existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // Client-side routes (/login, /c/...) load the app shell; unknown API paths stay JSON 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = await findSessionUser(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_input", issues: error.issues });
    }
    // Client errors raised by Fastify and its plugins (malformed JSON, rate limits) keep their status.
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: status === 429 ? "rate_limited" : "bad_request" });
    }
    reply.log.error(error);
    return reply.code(500).send({ error: "internal" });
  });

  app.get(
    "/api/ws",
    {
      websocket: true,
      preValidation: async (req, reply) => {
        if (!req.user) await reply.code(401).send({ error: "unauthenticated" });
      },
    },
    (socket, req) => hub.add(req.user!.id, socket),
  );

  hub.setPresenceAudience((userId) => coMemberIds(db, userId));

  // Guest accounts with an end date leave on the next sweep after it (at most a minute late).
  const sweep = () => void expireMemberships(db, hub).catch((err) => app.log.error({ err }, "membership expiry failed"));
  sweep();
  const sweeper = setInterval(sweep, 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));

  const lastTyping = new Map<string, number>();
  hub.handleClientEvents(async (userId, event) => {
    const key = `${userId}:${event.channelId}:${event.parentId ?? ""}`;
    const now = Date.now();
    if (now - (lastTyping.get(key) ?? 0) < TYPING_THROTTLE_MS) return;
    if (lastTyping.size > 10_000) lastTyping.clear();
    lastTyping.set(key, now);
    try {
      const access = await channelAccess(db, event.channelId, userId);
      if (!access?.isMember) return;
      const others = (await memberIds(db, event.channelId)).filter((id) => id !== userId);
      hub.publish({ users: others }, { type: "typing", channelId: event.channelId, parentId: event.parentId, userId });
    } catch (err) {
      app.log.error({ err }, "typing relay failed");
    }
  });

  await app.register(authRoutes, deps);
  await app.register(emailAuthRoutes, deps);
  await app.register(channelRoutes, deps);
  await app.register(messageRoutes, deps);
  await app.register(userRoutes, deps);
  await app.register(searchRoutes, deps);
  await app.register(fileRoutes, deps);
  await app.register(pushRoutes, deps);
  await app.register(savedRoutes, deps);
  await app.register(workspaceRoutes, deps);
  await app.register(inviteRoutes, deps);
  await app.register(webhookRoutes, deps);
  await app.register(appRoutes, deps);
  await app.register(botApiRoutes, deps);
  await app.register(interactionRoutes, deps);
  await app.register(slackApiRoutes, deps);
  return app;
}
