// Slack reaction names for the emoji Chatter stores as characters. Apps react
// by name; names outside this table are refused like unknown Slack emoji, and
// reactions without a name are reported by their character.

const NAMES: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  eyes: "👀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  warning: "⚠️",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  thinking_face: "🤔",
  tada: "🎉",
  rocket: "🚀",
  heart: "❤️",
  fire: "🔥",
  ok_hand: "👌",
  raised_hands: "🙌",
  clap: "👏",
  pray: "🙏",
  wave: "👋",
  joy: "😂",
  smile: "😄",
  slightly_smiling_face: "🙂",
  sob: "😭",
  sweat_smile: "😅",
  memo: "📝",
  pencil: "📝",
  gear: "⚙️",
  wrench: "🔧",
  hammer_and_wrench: "🛠️",
  robot_face: "🤖",
  speech_balloon: "💬",
  bulb: "💡",
  mag: "🔍",
  link: "🔗",
  clipboard: "📋",
  pushpin: "📌",
  stop_sign: "🛑",
  no_entry: "⛔",
  no_entry_sign: "🚫",
  arrows_counterclockwise: "🔄",
  repeat: "🔁",
  zap: "⚡",
  sparkles: "✨",
  star: "⭐",
  question: "❓",
  exclamation: "❗",
  red_circle: "🔴",
  large_green_circle: "🟢",
  large_yellow_circle: "🟡",
  large_blue_circle: "🔵",
  white_circle: "⚪",
  hundred: "💯",
  "100": "💯",
  muscle: "💪",
  brain: "🧠",
  books: "📚",
  package: "📦",
  lock: "🔒",
  key: "🔑",
  bell: "🔔",
  calendar: "📅",
  chart_with_upwards_trend: "📈",
  bug: "🐛",
  construction: "🚧",
  checkered_flag: "🏁",
  heavy_plus_sign: "➕",
  heavy_minus_sign: "➖",
};

const BY_CHARACTER = new Map<string, string>();
for (const [name, character] of Object.entries(NAMES)) if (!BY_CHARACTER.has(character)) BY_CHARACTER.set(character, name);

/** The character for a Slack name (colons and skin tones ignored); null when unknown. */
export function emojiForName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const bare = name.replace(/^:|:$/g, "").replace(/::skin-tone-\d$/, "");
  return NAMES[bare] ?? null;
}

export const nameForEmoji = (character: string) => BY_CHARACTER.get(character) ?? character;
