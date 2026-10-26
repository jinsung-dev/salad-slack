import { dismissEphemeral, useEphemeral } from "../ephemeral";
import { Markdown } from "../markdown";
import { useDirectory } from "../directory";
import { Blocks } from "./Blocks";
import { Avatar } from "./People";

/** Replies only this person sees, under the conversation they belong to. */
export function EphemeralList({ channelId, parentId, me }: { channelId: string; parentId: number | null; me: string }) {
  const { names } = useDirectory();
  const items = useEphemeral(channelId, parentId);
  if (items.length === 0) return null;
  return (
    <div className="ephemeral-list">
      {items.map((m) => (
        <article key={m.id} className="message ephemeral">
          <div className="gutter">
            <Avatar name={m.author.displayName} />
          </div>
          <div className="body">
            <header>
              <strong>{m.author.displayName}</strong>
              <span className="bot-badge">앱</span>
              <span className="muted only-you">나에게만 보임</span>
              <button className="link" onClick={() => dismissEphemeral(m.id)}>
                닫기
              </button>
            </header>
            {m.blocks ? (
              <Blocks blocks={m.blocks} messageId={null} me={me} interactive={false} />
            ) : (
              <div className="text">
                <Markdown text={m.text} names={names} me={me} />
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
