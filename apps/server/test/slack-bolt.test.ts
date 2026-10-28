import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { App, Channel, Workspace } from "@chatter/shared";
import { connect, signIn, uniqueName, useCluster } from "./helpers";

// The real Slack SDKs (slack_bolt + slack_sdk, Socket Mode over aiohttp)
// running examples/slack-bolt/app.py unmodified. Opt-in: point
// SLACK_BOLT_PYTHON at a Python with `slack_bolt` and `aiohttp` installed.

const PYTHON = process.env.SLACK_BOLT_PYTHON;
const EXAMPLE = fileURLToPath(new URL("../../../examples/slack-bolt/", import.meta.url));

describe.skipIf(!PYTHON)("a Slack Bolt app (examples/slack-bolt)", () => {
  const { urls } = useCluster(1);
  const base = () => urls[0]!;
  let bolt: ChildProcess | undefined;
  let output = "";
  afterAll(() => void bolt?.kill());

  it("answers mentions, DMs, a slash command and a button click", { timeout: 60_000 }, async () => {
    const owner = await signIn(base(), "owner");
    const w = (await owner.call<Workspace>("POST", "/api/workspaces", { name: "Bolt" })).body;
    const ws = (rest: string) => `/api/workspaces/${w.id}${rest}`;
    const channel = (await owner.call<Channel>("POST", ws("/channels"), { name: uniqueName() })).body;
    const app = (await owner.call<App>("POST", ws("/apps"), { name: "Bolt" })).body;
    await owner.call("PUT", ws(`/apps/${app.id}`), {
      name: "Bolt",
      scopes: ["chat:write", "channels:read", "channels:history", "users:read"],
      eventsUrl: null,
      eventTypes: ["message", "app_mention"],
      interactivityUrl: null,
      socketMode: true,
    });
    await owner.call("POST", ws(`/apps/${app.id}/commands`), { command: "echo" });
    await owner.call("POST", `/api/channels/${channel.id}/members`, { userIds: [app.botUserId] });
    const appToken = (await owner.call<App>("POST", ws(`/apps/${app.id}/app-token`))).body.appToken!;

    bolt = spawn(PYTHON!, [`${EXAMPLE}app.py`], {
      env: { ...process.env, PYTHONPATH: EXAMPLE, CHATTER_SLACK_API_URL: `${base()}/api/slack/`, SLACK_BOT_TOKEN: app.token!, SLACK_APP_TOKEN: appToken },
    });
    bolt.stdout!.on("data", (d) => (output += d));
    bolt.stderr!.on("data", (d) => (output += d));

    const live = connect(base(), owner.cookie);
    await live.ready();
    const post = (channelId: string, text: string) =>
      owner.call("POST", `/api/channels/${channelId}/messages`, { text, clientMsgId: randomUUID() }).then((r) => r.body as { id: number });

    try {
      // Until the app connects, events are retried; the first answer proves the whole path.
      const mention = await post(channel.id, `<@${app.botUserId}> 안녕`);
      const answer = await live.next("message.created", (e) => e.message.parentId === mention.id, 40_000);
      expect(answer.message).toMatchObject({ text: `<@${owner.id}> 불렀나요?`, author: { id: app.botUserId } });

      const dm = (await owner.call<Channel>("POST", ws("/dms"), { userIds: [app.botUserId] })).body;
      const question = await post(dm.id, "DM 질문");
      expect((await live.next("reaction.updated", (e) => e.messageId === question.id, 10_000)).reactions).toEqual([{ emoji: "👀", userIds: [app.botUserId] }]);
      const thinking = await live.next("message.created", (e) => e.message.channelId === dm.id && e.message.text === "생각 중…", 10_000);
      await live.next("message.updated", (e) => e.message.id === thinking.message.id && e.message.text === "DM 잘 받았습니다: DM 질문", 10_000);

      expect((await owner.call("POST", `/api/channels/${channel.id}/commands`, { command: "echo", text: "배포" })).status).toBe(204);
      const echoed = await live.next("message.created", (e) => e.message.text === "echo: 배포", 10_000);
      expect(echoed.message.blocks).toEqual([
        { type: "section", text: "*echo*: 배포" },
        { type: "actions", elements: [{ type: "button", text: "승인", actionId: "approve", value: "배포", style: "primary" }] },
      ]);
      expect((await owner.call("POST", `/api/messages/${echoed.message.id}/actions`, { actionId: "approve", value: "배포" })).status).toBe(204);
      const approved = await live.next("message.updated", (e) => e.message.id === echoed.message.id, 10_000);
      expect(approved.message.text).toBe(`<@${owner.id}> 님이 승인했습니다: 배포`);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- bolt output ---\n${output}`);
    } finally {
      live.ws.close();
    }
  });
});
