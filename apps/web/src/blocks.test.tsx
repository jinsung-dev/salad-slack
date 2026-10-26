import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { blocksSchema, type Block } from "@chatter/shared";
import { Blocks } from "./components/Blocks";
import { WorkspaceProvider } from "./workspace";

const render = (blocks: Block[]) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <WorkspaceProvider workspace={{ id: "w", name: "W", joinDomain: null, role: "member" }}>
        <Blocks blocks={blocks} messageId={1} me="me" interactive />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );

describe("message blocks", () => {
  it("renders sections, fields, context and buttons with safe text", () => {
    const html = render([
      { type: "section", text: "*배포* <script>x</script>", fields: ["버전: 1.2"] },
      { type: "divider" },
      { type: "context", elements: ["요청자: kim"] },
      { type: "actions", elements: [{ type: "button", text: "승인", actionId: "approve", style: "primary" }, { type: "button", text: "열기", url: "https://example.com" }] },
    ]);
    expect(html).toContain("<strong>배포</strong> &lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain('<div class="block-fields"><div>버전: 1.2</div></div>');
    expect(html).toContain('<hr class="block-divider"/>');
    expect(html).toContain('<button class="block-button primary">승인</button>');
    expect(html).toContain('<a class="block-button" href="https://example.com" target="_blank" rel="noreferrer noopener">열기</a>');
  });

  it("rejects layouts apps must not send", () => {
    expect(blocksSchema.safeParse([{ type: "actions", elements: [{ type: "button", text: "x", url: "javascript:alert(1)" }] }]).success).toBe(false);
    expect(blocksSchema.safeParse([{ type: "section" }]).success).toBe(false);
    expect(blocksSchema.safeParse([{ type: "iframe", src: "https://evil" }]).success).toBe(false);
    expect(blocksSchema.safeParse([]).success).toBe(false);
  });
});
