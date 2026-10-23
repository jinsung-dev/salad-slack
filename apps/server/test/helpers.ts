import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { sql } from "drizzle-orm";
import { WebSocket } from "ws";
import type { ClientEvent, ServerEvent } from "@chatter/shared";
import { startFakeOidc, type FakeOidc } from "../devtools/fake-oidc";
import { buildApp } from "../src/app";
import { createDb, runMigrations } from "../src/db/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://chatter:chatter@localhost:54329/chatter_test";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:56379";

/**
 * Starts `nodes` server instances sharing one fresh database and one Redis
 * namespace, like a horizontally scaled deployment. Call at module scope.
 */
export function useCluster(
  nodes = 1,
  options: Partial<Pick<Parameters<typeof buildApp>[0], "allowedEmailDomains" | "authRateLimit" | "webDist" | "maxFileBytes" | "push">> = {},
) {
  const { db, pool } = createDb(DATABASE_URL);
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const urls: string[] = [];
  // Unique per run so a dev server on the same Redis never sees test traffic.
  const redisPrefix = `chatter-test-${randomUUID()}:`;
  let oidc: FakeOidc | undefined;
  // Shared by every node, like the one disk of a single-server deployment.
  const fileStorageDir = mkdtempSync(join(tmpdir(), "chatter-files-"));

  beforeAll(async () => {
    await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await runMigrations(db);
    oidc = await startFakeOidc({ clientId: "test-client", clientSecret: "test-secret" });
    for (let i = 0; i < nodes; i++) {
      const app = await buildApp({
        db,
        redisUrl: REDIS_URL,
        redisPrefix,
        oidc: { issuer: oidc.issuer, clientId: "test-client", clientSecret: "test-secret" },
        cookieSecure: false,
        logger: false,
        // Tests sign in many users from one address.
        authRateLimit: 10_000,
        fileStorageDir,
        ...options,
      });
      apps.push(app);
      urls.push(await app.listen({ port: 0, host: "127.0.0.1" }));
    }
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await oidc?.close();
    await pool.end();
  });

  return { urls, db, fileStorageDir };
}

const cookieValue = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/**
 * The browser's side of signing in: start at Chatter, pick an account on the
 * (fake) provider's page, follow the callback. Returns where Chatter sent the
 * browser and the session cookie, if one was issued.
 */
export async function oidcSignIn(baseUrl: string, account: { email: string; name: string; emailVerified?: boolean }) {
  const start = await fetch(`${baseUrl}/api/auth/oidc/start`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const loginCookie = cookieValue(start, "oidc_login");
  const authorize = new URL(start.headers.get("location")!);

  const form = new URLSearchParams(authorize.searchParams);
  form.set("login_email", account.email);
  form.set("login_name", account.name);
  if (account.emailVerified !== false) form.set("login_email_verified", "true");
  const consent = await fetch(`${authorize.origin}/authorize`, { method: "POST", body: form, redirect: "manual" });
  expect(consent.status).toBe(302);

  const done = await fetch(consent.headers.get("location")!, {
    headers: loginCookie ? { cookie: loginCookie } : {},
    redirect: "manual",
  });
  return { status: done.status, location: done.headers.get("location"), session: cookieValue(done, "sid"), loginCookie };
}

export type Client = Awaited<ReturnType<typeof signIn>>;

/** A signed-in user with one session, talking to `baseUrl` (any node). */
export async function signIn(baseUrl: string, name: string, email = `${name}-${randomUUID()}@example.test`) {
  const result = await oidcSignIn(baseUrl, { email, name });
  expect(result.location).toBe("/");
  const cookie = result.session!;
  const call = async <T = any>(method: string, path: string, body?: unknown, url = baseUrl) => {
    const r = await fetch(`${url}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (r.status === 204 ? null : await r.json()) as T };
  };
  const me = await call<{ id: string }>("GET", "/api/auth/me");
  return { id: me.body.id, email, cookie, call };
}

export function connect(baseUrl: string, cookie?: string) {
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws`, { headers: cookie ? { cookie } : {} });
  const events: ServerEvent[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data) => {
    events.push(JSON.parse(String(data)));
    waiters.splice(0).forEach((w) => w());
  });

  /** The next unconsumed event of `type` matching `where`. */
  const next = async <T extends ServerEvent["type"]>(
    type: T,
    where: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<ServerEvent, { type: T }>> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex((e) => e.type === type && where(e as Extract<ServerEvent, { type: T }>));
      if (i >= 0) return events.splice(i, 1)[0] as Extract<ServerEvent, { type: T }>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        waiters.push(() => (clearTimeout(t), resolve()));
      });
    }
  };

  /** Fails if an event of `type` matching `where` arrives within `ms`. */
  const none = async <T extends ServerEvent["type"]>(
    type: T,
    where: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true,
    ms = 300,
  ) => {
    await expect(next(type, where, ms)).rejects.toThrow("timed out");
  };

  const send = (event: ClientEvent) => ws.send(JSON.stringify(event));
  const ready = () => next("hello");
  return { ws, next, none, send, ready };
}

export const uniqueName = () => `ch-${randomUUID().slice(0, 8)}`;
