import { buildApp } from "./app";
import { createDb, runMigrations } from "./db/client";
import { env } from "./env";
import { smtpMailer, type Mailer } from "./mail";
import type { OidcConfig } from "./oidc";
import { webPushSender } from "./webPush";

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

/** SMTP when configured; with the development fake provider, mail lands in files; otherwise none. */
async function guestMailer(fakeProvider: boolean): Promise<Mailer | null> {
  if (env.smtp) return smtpMailer(env.smtp);
  if (!fakeProvider) return null;
  const { devMailer } = await import("../devtools/dev-mailer");
  return devMailer(env.devMailDir);
}

const provider = await signInProvider();
const mailer = await guestMailer(Boolean(provider.close));
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
  fileStorageDir: env.fileStorageDir,
  maxFileBytes: env.maxFileBytes,
  allowPrivateAppUrls: env.allowPrivateAppUrls,
  mailer,
  push: env.vapid ? { publicKey: env.vapid.publicKey, send: webPushSender(env.vapid) } : null,
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
app.log.info(env.vapid ? "web push enabled" : "web push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");
if (env.allowedEmailDomains.length > 0) app.log.info(`sign-in limited to ${env.allowedEmailDomains.join(", ")}`);
app.log.info(env.smtp ? `guest email sign-in via ${env.smtp.host}` : mailer ? `guest email sign-in: mail written to ${env.devMailDir}` : "guest email sign-in disabled: set SMTP_USER and SMTP_PASSWORD");
