import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { env } from "./env";
import type { OidcConfig } from "./oidc";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The configured provider, or the development fake when none is set. */
async function signInProvider(): Promise<{ config: OidcConfig; close?: () => Promise<void> }> {
  if (env.oidcIssuer) {
    if (!env.oidcClientId || !env.oidcClientSecret) throw new Error("OIDC_ISSUER is set: also set OIDC_CLIENT_ID and OIDC_CLIENT_SECRET");
    return { config: { issuer: env.oidcIssuer, clientId: env.oidcClientId, clientSecret: env.oidcClientSecret } };
  }
  // The fake lets anyone claim any email, so it never serves other machines.
  if (!LOOPBACK.has(env.host)) {
    throw new Error(`HOST=${env.host} accepts other machines: configure a real sign-in provider (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)`);
  }
  const { startFakeOidc } = await import("../devtools/fake-oidc");
  const clientId = "chatter-dev";
  const clientSecret = "dev-secret";
  const fake = await startFakeOidc({ clientId, clientSecret });
  return { config: { issuer: fake.issuer, clientId, clientSecret }, close: fake.close };
}

const provider = await signInProvider();
const { db, pool } = createDb(env.databaseUrl);
await runMigrations(db);
const app = await buildApp({
  db,
  redisUrl: env.redisUrl,
  redisPrefix: env.redisPrefix,
  oidc: provider.config,
  publicUrl: env.publicUrl,
  cookieSecure: env.cookieSecure,
  allowedEmailDomains: env.allowedEmailDomains,
  authRateLimit: env.authRateLimit,
  webDist: env.webDist,
  trustProxy: env.trustProxy,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await provider.close?.();
    await pool.end();
    process.exit(0);
  });
}

await app.listen({ port: env.port, host: env.host });
if (provider.close) app.log.warn(`development sign-in: fake provider at ${provider.config.issuer}, any email is accepted`);
else app.log.info(`sign-in via ${provider.config.issuer}`);
if (env.allowedEmailDomains.length > 0) app.log.info(`sign-in limited to ${env.allowedEmailDomains.join(", ")}`);
