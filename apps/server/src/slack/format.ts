import { block as blockSchema, CHANNEL_MENTION, slackId, type Block } from "@chatter/shared";
import { fromSlackId } from "./ids";

// Text and Block Kit between Slack apps and Chatter. Chatter's message markup
// already follows Slack mrkdwn (*bold*, _italic_, ~strike~, `code`, ```blocks```),
// so only the angle-bracket tokens, HTML entities and mention ids change.

const CHATTER_TOKEN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>|<!channel>/g;

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescape = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Chatter message text as Slack mrkdwn. */
export function toSlackText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CHATTER_TOKEN)) {
    out += escape(text.slice(last, match.index));
    out += match[1] ? `<@${slackId("U", match[1])}>` : CHANNEL_MENTION;
    last = match.index + match[0].length;
  }
  return out + escape(text.slice(last));
}

/**
 * Slack mrkdwn as Chatter text: user mentions keep working, `<!channel>` and
 * `<!everyone>` notify the conversation, labelled links read "label (url)".
 * Only explicit tokens become mentions; escaped text stays literal.
 */
export function fromSlackText(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/<([^<>]*)>/g)) {
    out += unescape(text.slice(last, match.index));
    out += angleToken(match[1]!);
    last = match.index + match[0].length;
  }
  return out + unescape(text.slice(last));
}

function angleToken(inner: string): string {
  const bar = inner.indexOf("|");
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? "" : unescape(inner.slice(bar + 1));
  if (target.startsWith("@")) {
    const user = fromSlackId(target.slice(1), ["U"]);
    return user ? `<@${user}>` : `@${label || target.slice(1)}`;
  }
  if (target.startsWith("#")) return `#${label || target.slice(1)}`;
  if (target.startsWith("!")) {
    const command = target.slice(1);
    if (command === "channel" || command === "everyone") return CHANNEL_MENTION;
    if (command === "here") return "@here";
    // <!subteam^ID|@group>, <!date^…|fallback>
    return label || "";
  }
  const url = unescape(target);
  if (url.startsWith("mailto:")) return label || url.slice("mailto:".length);
  return label && label !== url ? `${label} (${url})` : url;
}

/** CommonMark (Slack's `markdown_text`) to Chatter markup: emphasis, strike, links and headings. */
export function fromMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            // One pass, so converted bold is not read again as CommonMark italic.
            .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_m, bold1, bold2, italic) =>
              italic !== undefined ? `_${italic}_` : `*${bold1 ?? bold2}*`,
            )
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/~~([^~\n]+)~~/g, "~$1~")
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => (label === url ? url : `${label} (${url})`)),
    )
    .join("");
}

// Block Kit -------------------------------------------------------------------

type SlackObject = Record<string, unknown>;
const isObject = (v: unknown): v is SlackObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A Block Kit text object, or a plain string, as Chatter text. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return fromSlackText(value);
  if (!isObject(value) || typeof value.text !== "string") return undefined;
  return value.type === "plain_text" ? value.text : fromSlackText(value.text);
}

const clip = (text: string | undefined, max: number) => (text === undefined ? undefined : text.trim().slice(0, max) || undefined);

function button(element: unknown): Block | null {
  if (!isObject(element) || element.type !== "button") return null;
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: clip(textOf(element.text), 75) ?? "",
        actionId: typeof element.url === "string" ? undefined : (element.action_id as string | undefined),
        value: typeof element.value === "string" ? element.value : undefined,
        url: typeof element.url === "string" ? element.url : undefined,
        style: element.style === "primary" || element.style === "danger" ? element.style : undefined,
      },
    ],
  };
}

/** One Slack block as zero or more Chatter blocks; layouts Chatter cannot show are left to the text. */
function convertBlock(b: SlackObject): Block[] {
  switch (b.type) {
    case "section": {
      const text = clip(textOf(b.text), 3000);
      const fields = Array.isArray(b.fields) ? b.fields.map((f) => clip(textOf(f), 3000)).filter((f): f is string => Boolean(f)).slice(0, 10) : [];
      const out: Block[] = text || fields.length > 0 ? [{ type: "section", text, fields: fields.length > 0 ? fields : undefined }] : [];
      const accessory = button(b.accessory);
      return accessory ? [...out, accessory] : out;
    }
    case "header": {
      const text = clip(textOf(b.text), 2998);
      return text ? [{ type: "section", text: `*${text}*` }] : [];
    }
    case "markdown": {
      const text = typeof b.text === "string" ? clip(fromMarkdown(b.text), 3000) : undefined;
      return text ? [{ type: "section", text }] : [];
    }
    case "divider":
      return [{ type: "divider" }];
    case "context": {
      const elements = (Array.isArray(b.elements) ? b.elements : [])
        .map((e) => clip(isObject(e) && e.type === "image" ? (e.alt_text as string | undefined) : textOf(e), 500))
        .filter((e): e is string => Boolean(e))
        .slice(0, 10);
      return elements.length > 0 ? [{ type: "context", elements }] : [];
    }
    case "actions": {
      const buttons = (Array.isArray(b.elements) ? b.elements : []).flatMap((e) => {
        const converted = button(e);
        return converted?.type === "actions" ? converted.elements : [];
      });
      return buttons.length > 0 ? [{ type: "actions", elements: buttons.slice(0, 5) }] : [];
    }
    default:
      // rich_text, image, input, video, …: `text` carries the message.
      return [];
  }
}

/** Slack blocks as valid Chatter blocks, dropping what does not convert; null when nothing remains. */
export function fromSlackBlocks(blocks: unknown): Block[] | null {
  if (!Array.isArray(blocks)) return null;
  const out = blocks
    .filter(isObject)
    .flatMap(convertBlock)
    .flatMap((b) => {
      const parsed = blockSchema.safeParse(b);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 50);
  return out.length > 0 ? out : null;
}

/** Text to stand in for blocks when an app sends none (Slack allows blocks alone). */
export function blocksText(blocks: Block[] | null): string {
  return (blocks ?? [])
    .flatMap((b) => (b.type === "section" ? [b.text, ...(b.fields ?? [])] : b.type === "context" ? b.elements : []))
    .filter(Boolean)
    .join("\n");
}

/** Chatter blocks in Block Kit, for message objects apps read back. */
export function toSlackBlocks(blocks: Block[] | null): SlackObject[] | undefined {
  if (!blocks) return undefined;
  return blocks.map((b, i): SlackObject => {
    const block_id = `b${i}`;
    switch (b.type) {
      case "section":
        return {
          type: "section",
          block_id,
          ...(b.text ? { text: { type: "mrkdwn", text: toSlackText(b.text) } } : {}),
          ...(b.fields ? { fields: b.fields.map((f) => ({ type: "mrkdwn", text: toSlackText(f) })) } : {}),
        };
      case "divider":
        return { type: "divider", block_id };
      case "context":
        return { type: "context", block_id, elements: b.elements.map((e) => ({ type: "mrkdwn", text: toSlackText(e) })) };
      case "actions":
        return {
          type: "actions",
          block_id,
          elements: b.elements.map((e) => ({
            type: "button",
            text: { type: "plain_text", text: e.text },
            ...(e.actionId ? { action_id: e.actionId } : {}),
            ...(e.value !== undefined ? { value: e.value } : {}),
            ...(e.url ? { url: e.url } : {}),
            ...(e.style ? { style: e.style } : {}),
          })),
        };
    }
  });
}

/** The block id `toSlackBlocks` gives the actions block holding `actionId`. */
export function actionBlockId(blocks: Block[] | null, actionId: string): string {
  const index = (blocks ?? []).findIndex((b) => b.type === "actions" && b.elements.some((e) => e.actionId === actionId));
  return `b${Math.max(index, 0)}`;
}
