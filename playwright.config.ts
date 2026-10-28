import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// E2E runs its own production build against a throwaway database, wiped at
// start, so test users and channels never appear where people work.
const PORT = 3101;
// Sign-in codes for outside guests land here as files (the server's development mailer).
export const E2E_MAIL_DIR = fileURLToPath(new URL("e2e/artifacts/mail", import.meta.url));

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/artifacts/results",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Uses the locally installed Chrome; run `pnpm exec playwright install chromium` and drop this to use the bundled one.
    channel: "chrome",
    viewport: { width: 1100, height: 700 },
  },
  webServer: {
    command: "pnpm build && pnpm --filter @chatter/server db:reset && pnpm --filter @chatter/server start",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Set explicitly so values in .env (which never override the environment) cannot leak in.
    env: {
      DATABASE_URL: "postgres://chatter:chatter@localhost:54329/chatter_e2e",
      REDIS_PREFIX: "chatter-e2e:",
      HOST: "127.0.0.1",
      PORT: String(PORT),
      ALLOWED_EMAIL_DOMAINS: "",
      // Empty: the server runs its in-process fake provider.
      OIDC_ISSUER: "",
      PUBLIC_URL: "",
      AUTH_RATE_LIMIT_PER_MINUTE: "1000",
      // The test's stand-in app server listens on 127.0.0.1 over plain HTTP.
      ALLOW_PRIVATE_APP_URLS: "true",
      // No SMTP: the development mailer writes guests' codes to files.
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      DEV_MAIL_DIR: E2E_MAIL_DIR,
    },
  },
});
