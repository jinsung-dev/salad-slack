import { fileURLToPath } from "node:url";

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://chatter:chatter@localhost:54329/chatter",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:56379",
  // Namespaces Redis channels and keys so several deployments can share one Redis.
  redisPrefix: process.env.REDIS_PREFIX ?? "chatter:",
  // Loopback by default; 0.0.0.0 to accept other machines (LAN testing, containers).
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  // Behind a reverse proxy (Caddy, a load balancer): use X-Forwarded-For for the client address.
  trustProxy: process.env.TRUST_PROXY === "true",
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10),
  // Google Workspace domains allowed to sign in. Empty = any verified account.
  allowedEmailDomains: list(process.env.ALLOWED_EMAIL_DOMAINS),
  // Sign-in provider. Google: https://accounts.google.com plus an OAuth client.
  // Unset: a fake provider runs in-process for local development (loopback only).
  oidcIssuer: process.env.OIDC_ISSUER || undefined,
  oidcClientId: process.env.OIDC_CLIENT_ID || undefined,
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
  // The origin people open, e.g. https://chatter.example.com; must match the provider's redirect URI.
  publicUrl: process.env.PUBLIC_URL || undefined,
  // Attachment bytes on local disk (one server); shared storage is needed for several.
  fileStorageDir: process.env.FILE_STORAGE_DIR ?? fileURLToPath(new URL("../../../data/uploads", import.meta.url)),
  maxFileBytes: Number(process.env.FILE_MAX_BYTES ?? 25 * 1024 * 1024),
  // Web Push keys (generate with `pnpm --filter @chatter/server vapid`); unset disables push.
  vapid:
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? {
          subject: process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
          publicKey: process.env.VAPID_PUBLIC_KEY,
          privateKey: process.env.VAPID_PRIVATE_KEY,
        }
      : null,
  // Outgoing mail for guests' sign-in codes, e.g. a Google Workspace account with an app password.
  // Unset: email sign-in is off (with the fake provider, mail is written to DEV_MAIL_DIR instead).
  smtp:
    process.env.SMTP_USER && process.env.SMTP_PASSWORD
      ? {
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: Number(process.env.SMTP_PORT || 465),
          user: process.env.SMTP_USER,
          password: process.env.SMTP_PASSWORD,
          from: process.env.MAIL_FROM || `Chatter <${process.env.SMTP_USER}>`,
        }
      : null,
  devMailDir: process.env.DEV_MAIL_DIR || fileURLToPath(new URL("../../../data/dev-mail", import.meta.url)),
  // Development only: let apps use http:// and private addresses (never on a shared server).
  allowPrivateAppUrls: process.env.ALLOW_PRIVATE_APP_URLS === "true",
  // The built web app, served from the same origin when present.
  webDist: process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
};
