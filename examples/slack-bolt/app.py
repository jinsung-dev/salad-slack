"""An unmodified Slack Bolt app (Socket Mode) that runs against Chatter.

    pip install slack_bolt aiohttp
    PYTHONPATH=examples/slack-bolt \
    CHATTER_SLACK_API_URL=https://<chatter>/api/slack/ \
    SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
    python examples/slack-bolt/app.py

- Mention the bot in a channel: it answers in the thread.
- DM the bot: it reacts with 👀, says it is thinking, then edits that message.
- /echo <text>: answers in the channel with an approve button; clicking it
  replaces the message through the response URL.
"""

import asyncio
import os

from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
from slack_bolt.async_app import AsyncApp

app = AsyncApp(token=os.environ["SLACK_BOT_TOKEN"])


@app.event("app_mention")
async def on_mention(event, say):
    await say(text=f"<@{event['user']}> 불렀나요?", thread_ts=event.get("thread_ts") or event["ts"])


@app.event("message")
async def on_message(event, say, client):
    if event.get("channel_type") != "im" or event.get("bot_id"):
        return
    await client.reactions_add(channel=event["channel"], timestamp=event["ts"], name="eyes")
    thinking = await say(text="생각 중…")
    await asyncio.sleep(0.5)
    await client.chat_update(channel=thinking["channel"], ts=thinking["ts"], text=f"DM 잘 받았습니다: {event['text']}")


@app.command("/echo")
async def on_echo(ack, command):
    await ack(
        response_type="in_channel",
        text=f"echo: {command['text']}",
        blocks=[
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*echo*: {command['text']}"}},
            {
                "type": "actions",
                "elements": [
                    {"type": "button", "action_id": "approve", "text": {"type": "plain_text", "text": "승인"}, "value": command["text"], "style": "primary"}
                ],
            },
        ],
    )


@app.action("approve")
async def on_approve(ack, body, respond):
    await ack()
    await respond(replace_original=True, text=f"<@{body['user']['id']}> 님이 승인했습니다: {body['actions'][0]['value']}")


async def main():
    await AsyncSocketModeHandler(app, os.environ["SLACK_APP_TOKEN"]).start_async()


if __name__ == "__main__":
    asyncio.run(main())
