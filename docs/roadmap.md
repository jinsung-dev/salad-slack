# Roadmap

Each phase ends with working software and tests covering its "done when" line.

## Phase 0 — Research ✅ (shell) / ⏳ (web client)

- [x] Desktop shell structure with REA → [research/phase-0-desktop-shell.md](research/phase-0-desktop-shell.md)
- [ ] Web client data model and realtime events (browser capture of own account)

## Phase 1 — MVP ✅

- [x] Sign-in, logout, httpOnly session cookie (email/password at first; replaced by Google sign-in on 2026-10-23)
- [x] Public channels: create, list, preview, join
- [x] Realtime messages over WebSocket with reconnect + resync
- [x] History paging with an id cursor
- [x] Idempotent sends (`clientMsgId`), unread counts, read cursor
- [x] Basic formatting: bold, italic, strike, code, code blocks, links

Done when: two browsers chat live; reload keeps history and unread state. Covered by `pnpm test` and `pnpm test:e2e`.

Phase 1 dogfooding was deferred into the Phase 2 gate.

## Phase 2 — Conversations ✅ (built; dogfooding gate open)

- [x] Threads: reply count, participants, thread panel, "also send to channel"
- [x] DMs and group DMs (up to 8 people, one conversation per set of people)
- [x] Private channels: invisible to non-members, invite to add
- [x] Mentions (`@user`, `@channel`) with a mention badge separate from unread; thread mentions clear on thread read
- [x] Edit and delete by the author, live everywhere; deleted thread parents stay as placeholders
- [x] Reactions (one per person and emoji)
- [x] Presence (active / away after 5 min idle / offline) and typing indicators
- [x] Redis pub/sub and cluster-wide presence: events reach users on any server node

- [x] Google sign-in (OIDC), limited to the `saladlab.co` Workspace; no passwords

Gate (PRD): the dogfooding team holds 90%+ of work conversation in Chatter for 2 weeks. Phase 0 web research and Phase 1 dogfooding were deferred into this gate (decision 2026-10-22).

## Phase 3 — Productivity + desktop (P0 and P2 built; P1 pending a decision)

- [x] File upload: picker, drag and drop, paste; images inline, other files as downloads (25 MB default)
- [x] Search: partial words (Korean included) across readable conversations, channel/author/period filters
- [x] Notification levels per conversation (all / mentions / off) and daily quiet hours
- [x] Web push for people not looking at Chatter; clicking opens the conversation or thread
- [x] Saved messages (P2)
- [ ] Desktop app (P1): Electron shell with native notifications, dock badge, `chatter://` links, tray
- [ ] Auto-update (P1): needs a code-signed macOS build (Apple Developer account)

Decisions: files on the server's local disk (one server; S3 needed for several), Postgres trigram search instead of a search engine. Started alongside the Phase 2 dogfooding gate (decision 2026-10-23).

## Phase 4 — Platform

- Multiple workspaces, invites, roles and permissions
- Bots, incoming webhooks, slash commands
- Structured message blocks

## Phase 5 — Advanced

- Voice/screen share (WebRTC via an SFU such as LiveKit)
- SSO, retention policies, audit log
- Mobile clients
