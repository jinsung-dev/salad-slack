import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders inline formatting and links", () => {
    expect(html("*b* _i_ ~s~ `c` https://example.com/x.")).toBe(
      '<strong>b</strong> <em>i</em> <s>s</s> <code>c</code> <a href="https://example.com/x" target="_blank" rel="noreferrer noopener">https://example.com/x</a>.',
    );
  });

  it("keeps code blocks literal", () => {
    expect(html("before\n```\n*not bold*\n```")).toBe("before<br/><pre>*not bold*</pre>");
  });

  it("renders mention tokens by display name and highlights the viewer", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const out = renderToStaticMarkup(<Markdown text={`<@${id}> <!channel>`} names={new Map([[id, "Kim"]])} me={id} />);
    expect(out).toBe('<span class="mention me">@Kim</span> <span class="mention me">@channel</span>');
  });

  it("escapes HTML instead of injecting it", () => {
    expect(html("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });
});
