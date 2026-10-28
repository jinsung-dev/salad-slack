# Building a Chatter app

An app belongs to one workspace. Admins create it under **워크스페이스 관리 → 앱**.
It gets a bot user (shown with an "앱" badge), a bot token (shown once,
reissue to rotate) and a signing secret. Add the bot to a channel with
**사람 추가**; it acts only in conversations it was added to.

## Bot API

`Authorization: Bearer <bot token>` on every call. Base path `/api/bot/v1`.
120 calls per minute per app.

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `auth.test` | — | `{ appId, botUserId, workspaceId, scopes }` |
| POST | `chat.postMessage` | `chat:write` | `{ channelId, text, blocks?, parentId? }`; the bot must be in the channel |
| GET | `conversations.list` | `channels:read` | Public channels and conversations the bot is in |
| GET | `conversations.history?channelId=&before=&limit=` | `channels:history` | Newest page first, messages ascending; bot must be in the channel |
| GET | `users.list` | `users:read` | Workspace members and bots |

Errors: `401 invalid_token`, `403 missing_scope` (with `needed`), `404 channel_not_found`.

## Requests Chatter sends to the app

Events, slash commands and button clicks are JSON `POST`s to URLs set on the
app. They must use HTTPS and may not resolve to a private or loopback
address. Chatter does not follow redirects.

Verify each request:

```text
x-chatter-request-timestamp: 1792900000
x-chatter-signature: v1=<hex HMAC-SHA256(signing secret, "v1:" + timestamp + ":" + raw body)>
```

Reject requests older than a few minutes.

### Events

Subscribe with an events URL and event types. Delivered for messages in
conversations the bot is in, never for the bot's own messages. Answer 2xx;
other answers are retried twice (after 1 s and 5 s, header `x-chatter-retry-num`).

```json
{ "type": "event_callback", "eventId": "…", "eventTime": 1792900000, "appId": "…", "workspaceId": "…",
  "event": { "type": "message" | "app_mention", "channelId": "…", "message": { "id": 42, "text": "…", "author": { … } } } }
```

### Slash commands

Each command has its own URL. Payload:

```json
{ "type": "slash_command", "command": "/deploy", "text": "prod", "appId": "…", "workspaceId": "…",
  "channelId": "…", "parentId": null, "user": { "id": "…", "displayName": "…" }, "responseUrl": "https://…/api/response-urls/…" }
```

Answer within **3 seconds** with a reply (below), or with an empty 2xx and
reply later through `responseUrl`: up to 5 times within 30 minutes.

### Button clicks

Set the app's interactivity URL. Payload `type: "block_actions"` with
`messageId`, `action: { actionId, value }`, `user` and `responseUrl`.

### Replies

```json
{ "text": "fallback and notification text", "blocks": [ … ], "responseType": "ephemeral" | "in_channel", "replaceOriginal": false }
```

- `ephemeral` (default): only the person who ran the command or clicked sees it; not stored.
- `in_channel`: posted in the conversation as the bot.
- `replaceOriginal: true` (clicks): replaces the message that holds the button.

## Blocks

Apps (bot API, webhooks, replies) may send up to 50 blocks; `text` is always
required as the fallback for search, notifications and previews. Text uses
the same Markdown as messages.

| Block | Fields |
| --- | --- |
| `section` | `text?`, `fields?` (up to 10); at least one |
| `divider` | — |
| `context` | `elements`: up to 10 short strings |
| `actions` | `elements`: up to 5 buttons |

A button is `{ "type": "button", "text": "승인", "actionId": "approve", "value"?: "…", "style"?: "primary" | "danger" }`,
or a link `{ "type": "button", "text": "열기", "url": "https://…" }`.

## Sample app

[examples/sample-app/server.mjs](../examples/sample-app/server.mjs) answers
`/commands` (`ping`, `deploy <env>`, `later`), `/actions` (approve/reject buttons)
and `/events` (replies to mentions through the bot API). It listens on
127.0.0.1:4000; expose it over HTTPS (for example its own ngrok tunnel) and use
those URLs on the app.

## Slack apps

Apps built on Slack's SDKs (Bolt, `slack_sdk`, Hermes) can use Chatter's
Slack-compatible API at `/api/slack/` and **Socket Mode** instead of the URLs
above: the app connects to Chatter, so no public address is needed, and
commands of Socket Mode apps need no URL. See [slack-compat.md](slack-compat.md).

## Local development

`ALLOW_PRIVATE_APP_URLS=true` lets apps use `http://` and local addresses.
Never set it on a server other people use.
