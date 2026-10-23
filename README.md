# Chatter

A team chat app built phase by phase. See [docs/roadmap.md](docs/roadmap.md).

## Stack

| Part | Tech |
| --- | --- |
| `apps/web` | React 19, Vite, TanStack Query, React Router |
| `apps/server` | Fastify 5, `@fastify/websocket`, Drizzle ORM, Postgres 17, Redis 7 (ioredis) |
| `packages/shared` | zod request contracts, response and realtime event types |

## Getting started

Requires Node 24+, pnpm 11 and Docker.

```bash
pnpm install
cp .env.example .env
pnpm db:up      # Postgres on localhost:54329 (also creates chatter_test), Redis on 56379
pnpm dev        # server :3001 (runs migrations on start), web :5173
```

Open http://localhost:5173 in two browser profiles to chat between users.
Locally, "Google 계정으로 로그인" goes to a fake provider where any email works;
real Google sign-in is set up in [docs/google-sign-in.md](docs/google-sign-in.md).

To let coworkers on the office network use it, see [docs/lan-testing.md](docs/lan-testing.md).

## Checks

```bash
pnpm typecheck
pnpm test       # server integration tests (two-node cluster on chatter_test + Redis) + web unit tests
pnpm test:e2e   # Playwright on its own production build and wiped chatter_e2e database; needs Google Chrome
```

## Schema changes

Edit `apps/server/src/db/schema.ts`, then `pnpm db:generate` and commit the new
file in `apps/server/drizzle/`. Migrations apply on server start.

## Design notes

- Writes go through REST; the WebSocket pushes server events. Clients send only
  ephemeral signals on it (typing, active/away), never persisted writes, so
  every write has one validated path. Clients resync with a refetch after
  reconnecting.
- Every server node publishes events to one Redis channel and delivers those
  addressed to its own sockets. Presence is each node's socket counts in a
  Redis hash that expires if the node dies.
- Mentions are stored inline as `<@user-id>` / `<!channel>` tokens and expanded
  into a `mentions` table at send time; the composer shows `@Name`.
- Private channels and DMs are indistinguishable from missing ones to
  non-members (404), in REST and realtime alike.
- `apps/server/src/queries.ts` owns the Channel and Message response shapes, so
  a REST response and the realtime event for the same change are identical.
- `messages.id` is a global monotonic cursor used for paging, read state and
  unread counts.
- `apps/web/src/cache.ts` owns every client cache mutation, so the REST
  response and realtime event for the same change deduplicate the same way.
