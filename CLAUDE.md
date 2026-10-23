# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chatter is a team chat app (Slack-like) built phase by phase; current scope and decisions live in `docs/roadmap.md`. pnpm monorepo: `apps/server` (Fastify 5 + Drizzle/Postgres 17 + Redis), `apps/web` (React 19 + Vite + TanStack Query + React Router), `packages/shared` (zod request contracts, response and realtime event types, imported as TS source via `@chatter/shared`). Requires Node 24+, pnpm 11, Docker.

## Commands

```bash
pnpm install && cp .env.example .env
pnpm db:up            # Postgres 127.0.0.1:54329 (also creates chatter_test), Redis 127.0.0.1:56379
pnpm dev              # server :3001 (runs migrations on start) + web :5173 (Vite proxies /api incl. WS)
pnpm typecheck        # all packages
pnpm test             # server integration tests + web unit tests (needs db:up)
pnpm test:e2e         # Playwright: own prod build on :3101, wipes chatter_e2e DB; uses local Google Chrome
pnpm db:generate      # after editing apps/server/src/db/schema.ts; commit the new file in apps/server/drizzle/
pnpm --filter @chatter/server vapid    # generate Web Push keys
```

Single test file / test name:

```bash
pnpm --filter @chatter/server exec vitest run test/phase2.test.ts
pnpm --filter @chatter/server exec vitest run -t "partial name"
pnpm --filter @chatter/web exec vitest run src/cache.test.ts
pnpm exec playwright test -g "name"
```

## Testing model

- Server tests are integration tests against real Postgres (`chatter_test`) and Redis — no mocks. `useCluster(n)` in `apps/server/test/helpers.ts` (call at module scope) drops and re-migrates the schema, starts `n` app nodes on random ports sharing one DB and a unique Redis prefix, and a fake OIDC provider. Use `signIn(url, name)` to get a client with `.call(method, path, body)`; pass different node URLs to exercise cross-node realtime.
- Test files run serially (`fileParallelism: false`) because they share one schema.
- Override DB/Redis with `TEST_DATABASE_URL` / `TEST_REDIS_URL`.

## Architecture

- **Writes go through REST; the WebSocket only pushes server events.** Clients send only ephemeral signals over WS (typing, active/away, focus) — never persisted writes. Clients refetch to resync after reconnecting.
- **Cluster fan-out** (`apps/server/src/realtime.ts`, `RealtimeHub`): every node publishes events to one Redis channel (`${REDIS_PREFIX}events`) and delivers those addressed to its own sockets. Presence is each node's socket counts in a Redis hash that expires if the node dies. Code must work with multiple server nodes (tests run two).
- **Single owners of shapes and mutations:**
  - `apps/server/src/queries.ts` builds Channel/Message response shapes, so a REST response and the realtime event for the same change are identical. Also owns access checks (`channelAccess`, `memberIds`).
  - `apps/web/src/cache.ts` owns every TanStack Query cache mutation (and the query `keys`), used by both REST responses and realtime handlers (`apps/web/src/realtime.tsx`) so they dedupe the same way.
  - `apps/server/src/notify.ts` alone decides who gets a push notification and its content (levels all/mentions/none, thread rules, focus, quiet hours).
- **Visibility:** private channels and DMs are indistinguishable from missing ones to non-members — return 404, in REST and realtime alike.
- **Mentions** are stored inline in message text as `<@user-id>` / `<!channel>` tokens and expanded into a `mentions` table at send time; the composer displays `@Name`.
- **`messages.id`** is a global monotonic cursor used for history paging, read state and unread counts. Sends are idempotent via `clientMsgId`. Message pages are newest-first; messages within a page ascend.
- **Composition:** `apps/server/src/app.ts` `buildApp(deps)` wires plugins, the hub, OIDC, file store and `routes/*`; `src/index.ts` reads `src/env.ts` and starts it. The server also serves `apps/web/dist` from the same origin when built (`pnpm start`).
- **Auth:** OIDC only (Google, optionally restricted by `ALLOWED_EMAIL_DOMAINS`), httpOnly `sid` session cookie. With `OIDC_ISSUER` unset, an in-process fake provider (`apps/server/devtools/fake-oidc`) accepts any email, and the server refuses to start on a non-loopback `HOST` in that mode. See `docs/google-sign-in.md`, `docs/lan-testing.md`.
- **Files** are stored on local disk (`FILE_STORAGE_DIR`, default `data/uploads`) — single-server assumption. **Search** uses Postgres `pg_trgm` (partial words, Korean included), not a search engine.
- **Migrations** are drizzle-kit generated SQL in `apps/server/drizzle/` and apply automatically on server start; hand-written SQL migrations (e.g. extensions, trigram indexes) also live there.

## Git conventions

Use the `git-expert` subagent (`.claude/agents/git-expert.md`) for git work. Summary: never commit directly to `main`; branches `<type>/<kebab-desc>`; Conventional Commits with Korean summaries, e.g. `feat(web): 스레드 패널에 입력 중 표시 추가`. Scopes: `server`, `web`, `shared`, `db`, `realtime`, `auth`, `e2e`, `docs`, `deps`. Changes to `packages/shared` contracts, API response shapes or env var names are breaking (`!` + `BREAKING CHANGE:`).
