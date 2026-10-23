import { describe, expect, it } from "vitest";
import { toDisplay, toTokens } from "./directory";

const kim = "11111111-1111-4111-8111-111111111111";
const kimLee = "22222222-2222-4222-8222-222222222222";

describe("mention conversion", () => {
  it("turns picked names into tokens, longest name first", () => {
    const picked = new Map([
      ["@Kim", kim],
      ["@Kim Lee", kimLee],
    ]);
    expect(toTokens("@Kim Lee and @Kim, @channel!", picked)).toBe(`<@${kimLee}> and <@${kim}>, <!channel>!`);
  });

  it("leaves names the user never picked as plain text", () => {
    expect(toTokens("mail me@kim.dev or @Kim", new Map())).toBe("mail me@kim.dev or @Kim");
  });

  it("round-trips stored text through the editor", () => {
    const names = new Map([[kim, "Kim"]]);
    const stored = `hi <@${kim}> <!channel>`;
    const { text, picked } = toDisplay(stored, names);
    expect(text).toBe("hi @Kim @channel");
    expect(toTokens(text, picked)).toBe(stored);
  });
});
