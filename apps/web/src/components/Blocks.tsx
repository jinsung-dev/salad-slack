import { useState } from "react";
import type { Block, ButtonElement } from "@chatter/shared";
import { api } from "../api";
import { Markdown } from "../markdown";
import { useDirectory } from "../directory";

/** An app's structured layout. Text goes through the same safe Markdown as messages. */
export function Blocks({ blocks, messageId, me, interactive }: { blocks: Block[]; messageId: number | null; me: string; interactive: boolean }) {
  const { names } = useDirectory();
  return (
    <div className="blocks">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "section":
            return (
              <div key={i} className="block-section">
                {b.text && (
                  <div className="text">
                    <Markdown text={b.text} names={names} me={me} />
                  </div>
                )}
                {b.fields && (
                  <div className="block-fields">
                    {b.fields.map((f, j) => (
                      <div key={j}>
                        <Markdown text={f} names={names} me={me} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          case "divider":
            return <hr key={i} className="block-divider" />;
          case "context":
            return (
              <div key={i} className="block-context muted">
                {b.elements.map((e, j) => (
                  <span key={j}>
                    <Markdown text={e} names={names} me={me} />
                  </span>
                ))}
              </div>
            );
          case "actions":
            return (
              <div key={i} className="block-actions">
                {b.elements.map((e, j) => (
                  <ActionButton key={j} button={e} messageId={messageId} interactive={interactive} />
                ))}
              </div>
            );
        }
      })}
    </div>
  );
}

function ActionButton({ button, messageId, interactive }: { button: ButtonElement; messageId: number | null; interactive: boolean }) {
  const [busy, setBusy] = useState(false);
  const className = ["block-button", button.style].filter(Boolean).join(" ");
  if (button.url) {
    return (
      <a className={className} href={button.url} target="_blank" rel="noreferrer noopener">
        {button.text}
      </a>
    );
  }
  // Ephemeral messages have no stored message for the app to act on.
  const usable = interactive && messageId !== null && button.actionId !== undefined;
  return (
    <button
      className={className}
      disabled={!usable || busy}
      onClick={() => {
        setBusy(true);
        void api.clickAction(messageId!, button.actionId!, button.value).finally(() => setBusy(false));
      }}
    >
      {button.text}
    </button>
  );
}
