// A minimal Chatter app for trying out commands, buttons and events. No dependencies.
//   SIGNING_SECRET=… BOT_TOKEN=… CHATTER_URL=https://… node examples/sample-app/server.mjs
// Routes: POST /commands (slash command URL), /actions (interactivity URL), /events (events URL).
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4000);
const secret = process.env.SIGNING_SECRET;
const botToken = process.env.BOT_TOKEN;
const chatterUrl = process.env.CHATTER_URL?.replace(/\/$/, "");
if (!secret) throw new Error("SIGNING_SECRET is required");

function verified(req, body) {
  const ts = req.headers["x-chatter-request-timestamp"];
  const sig = req.headers["x-chatter-signature"];
  if (typeof ts !== "string" || typeof sig !== "string") return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from("v1=" + createHmac("sha256", secret).update(`v1:${ts}:${body}`).digest("hex"));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function botApi(method, payload) {
  if (!botToken || !chatterUrl) return console.log(`skip ${method}: BOT_TOKEN or CHATTER_URL not set`);
  const res = await fetch(`${chatterUrl}/api/bot/v1/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`${method} → ${res.status}`);
}

const deployBlocks = (env, user) => [
  { type: "section", text: `*${env}* 배포를 요청했어요.`, fields: [`*요청자*\n${user}`, `*환경*\n${env}`] },
  { type: "context", elements: ["샘플 앱이 보낸 메시지입니다"] },
  {
    type: "actions",
    elements: [
      { type: "button", text: "승인", actionId: "approve", value: env, style: "primary" },
      { type: "button", text: "거절", actionId: "reject", value: env, style: "danger" },
    ],
  },
];

function handle(path, payload) {
  if (path === "/commands") {
    const text = payload.text.trim();
    if (text === "" || text === "help") {
      return { text: "사용법: `/sample ping`, `/sample deploy <환경>`, `/sample later`" };
    }
    if (text === "ping") return { text: "pong 🏓 (나에게만 보임)" };
    if (text.startsWith("deploy")) {
      const env = text.split(/\s+/)[1] ?? "staging";
      return { text: `${env} 배포 요청`, blocks: deployBlocks(env, payload.user.displayName), responseType: "in_channel" };
    }
    if (text === "later") {
      // Empty 2xx now, the real answer through responseUrl after the 3 s window.
      setTimeout(() => {
        void fetch(payload.responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "5초 뒤에 도착한 답장입니다", responseType: "in_channel" }),
        }).then((r) => console.log(`responseUrl → ${r.status}`));
      }, 5000);
      return null;
    }
    return { text: `모르는 명령이에요: ${text}` };
  }
  if (path === "/actions") {
    const { actionId, value } = payload.action;
    const verdict = actionId === "approve" ? "✅ 승인" : "❌ 거절";
    return { text: `${value} 배포 ${verdict}`, blocks: [{ type: "section", text: `*${value}* 배포: ${verdict} (by ${payload.user.displayName})` }], replaceOriginal: true };
  }
  if (path === "/events") {
    const { event } = payload;
    console.log(`event ${event.type} in ${event.channelId}: ${event.message.text}`);
    if (event.type === "app_mention") {
      void botApi("chat.postMessage", { channelId: event.channelId, text: `불렀어요? 받은 메시지: "${event.message.text}"`, parentId: event.message.parentId ?? undefined });
    }
    return null;
  }
  return undefined;
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/") {
      return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("샘플 앱이 실행 중입니다. Chatter가 /commands, /actions, /events로 POST 요청을 보냅니다.\n");
    }
    if (req.method !== "POST") return res.writeHead(405).end();
    if (!verified(req, body)) {
      console.log(`rejected ${req.url}: bad signature`);
      return res.writeHead(401).end();
    }
    const out = handle(req.url, JSON.parse(body));
    if (out === undefined) return res.writeHead(404).end();
    if (out === null) return res.writeHead(200).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
}).listen(port, "127.0.0.1", () => console.log(`sample app on http://127.0.0.1:${port}`));
