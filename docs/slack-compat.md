# Slack apps on Chatter

Chatter speaks enough of Slack's Web API and Socket Mode that apps built on
Slack's SDKs (Bolt, `slack_sdk`) run unmodified: point their API base URL at
`https://<chatter>/api/slack/` and give them a Chatter bot token and app-level
token. Socket Mode means the app connects out to Chatter, so it needs no public
URL or tunnel.

Verified: the Python SDKs Hermes pins (slack-bolt 1.30.0, slack-sdk 3.45.0)
running [examples/slack-bolt/app.py](../examples/slack-bolt/app.py) (mentions,
DMs with a reaction and an edit, a slash command, a button). Not verified: Hermes
itself, and Bolt for JavaScript.

## Set up an app

In **워크스페이스 관리 → 앱**:

1. Create the app and keep the **bot token** (`xoxb-…`, shown once).
2. Open it, tick every scope, both events (`message`, `app_mention`) and
   **Socket Mode**, then save. URLs stay empty.
3. Press **앱 토큰 발급** and keep the **app token** (`xapp-…`, shown once).
4. Add commands the app handles (e.g. `hermes`) with an empty URL.
5. Add the bot to channels with **사람 추가**; people can DM it directly.

**Slack 호환 정보** on the app shows the API address, the team id, the bot's
user id and yours (`U…`, for allowlists such as `SLACK_ALLOWED_USERS`).

## Point the SDK at Chatter

Python (`slack_sdk`, `slack_bolt`, Hermes): `slack_sdk` has no setting for
its address, so [examples/slack-bolt/sitecustomize.py](../examples/slack-bolt/sitecustomize.py)
sets it at interpreter startup. Socket Mode follows because its WebSocket URL
comes from `apps.connections.open`.

```bash
export PYTHONPATH=/path/to/chatter/examples/slack-bolt
export CHATTER_SLACK_API_URL=https://<chatter>/api/slack/
export SLACK_BOT_TOKEN=xoxb-…  SLACK_APP_TOKEN=xapp-…
python examples/slack-bolt/app.py
```

JavaScript (`@slack/bolt`, unverified): `new App({ token, appToken, socketMode: true, clientOptions: { slackApiUrl: "https://<chatter>/api/slack/" } })`.

### Hermes

With the environment above (plus `SLACK_ALLOWED_USERS=U…` from the app page, or
`GATEWAY_ALLOW_ALL_USERS=true`), run `hermes gateway run`. Register the
commands Hermes declares (at least `hermes`). Hermes still needs its own model
provider key. Expected differences, from its source: native streaming
(`chat.startStream`) answers `unknown_method`, so Hermes falls back to posting
and editing; files sent to or from Hermes do not arrive; the model picker
(a select menu) is not shown.

## What maps to what

| Slack | Chatter |
| --- | --- |
| `T…` team, `U…` user, `B…` bot, `A…` app | `T`/`U`/`B`/`A` + the Chatter UUID in upper-case hex |
| `C…` channel, `D…` DM, `G…` group DM | the conversation's UUID with that letter |
| message `ts` | `<creation second>.<message id mod 10⁶>` |
| mrkdwn `<@U…>`, `<!channel>`, `<url\|label>`, `&amp;` | `<@uuid>`, `<!channel>`, `label (url)`, `&` (`<!here>` stays text) |
| Block Kit `section`, `header`, `markdown`, `context`, `divider`, buttons | Chatter blocks; other blocks and elements are dropped and `text` stays |
| reaction names (`eyes`, `white_check_mark`, …) | emoji characters ([slack/emoji.ts](../apps/server/src/slack/emoji.ts)) |
| scopes | `chat:write` (posting, edits, reactions, DMs), `channels:read`, `channels:history`, `users:read` |

Methods: `auth.test`, `team.info`, `apps.connections.open`, `chat.postMessage`
(`thread_ts`, `reply_broadcast`, `blocks`, `markdown_text`, a user id as
`channel` posts to the DM), `chat.update`, `chat.delete`, `chat.postEphemeral`,
`conversations.info`, `.list`, `.history`, `.replies`, `.open`,
`users.conversations`, `users.info`, `users.list`, `bots.info`,
`reactions.add`, `reactions.remove`, `assistant.threads.setStatus` (shown as
the bot typing), `.setTitle` and `.setSuggestedPrompts` (accepted, no effect).
Anything else answers `unknown_method`. Answers are HTTP 200 with `ok`, and
600 calls per minute per token (then 429 `ratelimited`).

Socket Mode delivers `events_api` (for a mention, `app_mention` and then
`message` with `channel_type`, sharing one `ts`), `slash_commands` (an acknowledgement payload
is the reply) and `interactive` (`block_actions`). `response_url`s accept
Slack's `text`, `blocks`, `response_type`, `replace_original` and
`delete_original`. Unacknowledged events are retried after 5 and 30 seconds
with the same `event_id`. Events pending when the server stops are lost.
Up to 10 connections per app per server node; the
connection gets `{"type":"disconnect","reason":"link_disabled"}` when Socket
Mode is turned off, the app token is reissued or the app is deleted.

Not sent: edits, deletions, reactions and joins as events; files; modals
(`views.*`); select menus.

## Testing

`apps/server/test/slack-compat.test.ts` covers the API and Socket Mode across
two nodes. `apps/server/test/slack-bolt.test.ts` runs the example app with the
real SDKs and is skipped unless `SLACK_BOLT_PYTHON` names a Python with
`slack_bolt` and `aiohttp`:

```bash
uv venv /tmp/bolt && uv pip install --python /tmp/bolt/bin/python slack_bolt aiohttp
SLACK_BOLT_PYTHON=/tmp/bolt/bin/python pnpm --filter @chatter/server exec vitest run test/slack-bolt.test.ts
```
