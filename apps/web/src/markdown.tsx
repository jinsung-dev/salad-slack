import { Fragment, type ReactNode } from "react";
import { nameOf, type Names } from "./directory";

// Minimal message formatting rendered as React elements (never raw HTML):
// ```code blocks```, `inline code`, *bold*, _italic_, ~strike~, bare URLs,
// and mention tokens (`<@id>`, `<!channel>`).

const INLINE =
  /(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]])|<@([0-9a-f-]{36})>|(<!channel>)/g;

interface Ctx {
  names: Names;
  me: string | undefined;
}

function renderInline(text: string, keyPrefix: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [token] = match;
    const start = match.index;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${start}`;
    const inner = token.slice(1, -1);
    if (match[1]) out.push(<code key={key}>{inner}</code>);
    else if (match[2]) out.push(<strong key={key}>{inner}</strong>);
    else if (match[3]) out.push(<em key={key}>{inner}</em>);
    else if (match[4]) out.push(<s key={key}>{inner}</s>);
    else if (match[5])
      out.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener">
          {token}
        </a>,
      );
    else if (match[6])
      out.push(
        <span key={key} className={match[6] === ctx.me ? "mention me" : "mention"}>
          @{nameOf(ctx.names, match[6])}
        </span>,
      );
    else
      out.push(
        <span key={key} className="mention me">
          @channel
        </span>,
      );
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, names = new Map(), me }: { text: string; names?: Names; me?: string }) {
  const ctx = { names, me };
  const parts = text.split(/```\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i}>{part.replace(/\n$/, "")}</pre>
        ) : (
          <Fragment key={i}>
            {part.split("\n").map((line, j, lines) => (
              <Fragment key={j}>
                {renderInline(line, `${i}-${j}`, ctx)}
                {j < lines.length - 1 && <br />}
              </Fragment>
            ))}
          </Fragment>
        ),
      )}
    </>
  );
}
