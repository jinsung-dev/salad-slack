import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Message } from "@chatter/shared";
import { api } from "../api";
import { keys, replaceMessage, updateMessage } from "../cache";
import { nameOf, toDisplay, toTokens, useDirectory, type MentionMap } from "../directory";
import { Markdown } from "../markdown";
import { MentionTextarea } from "./MentionTextarea";
import { MessageFiles } from "./Files";
import { Avatar } from "./People";
import { useCurrentWorkspace } from "../workspace";

const GROUP_WINDOW_MS = 5 * 60 * 1000;
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥"];

const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });

export function MessageRow({
  message,
  previous,
  me,
  canInteract,
  onOpenThread,
}: {
  message: Message;
  previous: Message | undefined;
  me: string;
  canInteract: boolean;
  /** Omitted inside a thread, where replies cannot have threads. */
  onOpenThread?: (id: number) => void;
}) {
  const qc = useQueryClient();
  const { names, guests } = useDirectory();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const workspace = useCurrentWorkspace();
  const saved =
    useQuery({ queryKey: keys.saved(workspace.id), queryFn: () => api.saved(workspace.id) }).data?.messages.some((m) => m.id === message.id) ?? false;

  const at = new Date(message.createdAt);
  const prevAt = previous ? new Date(previous.createdAt) : undefined;
  const newDay = !prevAt || prevAt.toDateString() !== at.toDateString();
  const grouped =
    !newDay &&
    !previous?.deleted &&
    !previous?.thread &&
    previous?.author.id === message.author.id &&
    at.getTime() - prevAt!.getTime() < GROUP_WINDOW_MS;
  const mine = message.author.id === me;

  const toggleReaction = async (emoji: string) => {
    setPicking(false);
    const has = message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(me));
    const reactions = await api.react(message.id, emoji, !has);
    updateMessage(qc, message.channelId, message.id, (m) => ({ ...m, reactions }));
  };

  const toggleSaved = async () => {
    await api.setSaved(message.id, !saved);
    void qc.invalidateQueries({ queryKey: keys.saved(workspace.id) });
  };

  const remove = async () => {
    if (!confirm("이 메시지를 삭제할까요?")) return;
    await api.deleteMessage(message.id);
  };

  return (
    <>
      {newDay && (
        <div className="day-divider">
          <span>{dayFormat.format(at)}</span>
        </div>
      )}
      <article className={["message", grouped && "grouped", message.deleted && "deleted"].filter(Boolean).join(" ")}>
        <div className="gutter">
          {grouped ? <time className="hover-time">{timeFormat.format(at)}</time> : <Avatar name={message.author.displayName} />}
        </div>
        <div className="body">
          {!grouped && (
            <header>
              <strong>{message.author.displayName}</strong>
              {guests.has(message.author.id) && <span className="guest-badge">게스트</span>}
              <time dateTime={message.createdAt}>{timeFormat.format(at)}</time>
            </header>
          )}
          {message.parentId !== null && message.alsoSentToChannel && onOpenThread && (
            <button className="link thread-origin" onClick={() => onOpenThread(message.parentId!)}>
              스레드 답글
            </button>
          )}
          {message.deleted ? (
            <div className="text muted">(삭제된 메시지입니다)</div>
          ) : editing ? (
            <EditBox message={message} onDone={() => setEditing(false)} />
          ) : (
            <>
              {message.text && (
                <div className="text">
                  <Markdown text={message.text} names={names} me={me} />
                  {message.editedAt && <span className="edited muted"> (수정됨)</span>}
                </div>
              )}
              <MessageFiles files={message.files} />
            </>
          )}
          {message.reactions.length > 0 && (
            <div className="reactions">
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className={r.userIds.includes(me) ? "reaction mine" : "reaction"}
                  title={r.userIds.map((id) => nameOf(names, id)).join(", ")}
                  onClick={() => canInteract && void toggleReaction(r.emoji)}
                  disabled={!canInteract}
                >
                  {r.emoji} {r.userIds.length}
                </button>
              ))}
            </div>
          )}
          {message.thread && onOpenThread && (
            <button className="thread-summary" onClick={() => onOpenThread(message.id)}>
              <span className="participants">
                {message.thread.participantIds.map((id) => (
                  <Avatar key={id} name={nameOf(names, id)} size="sm" />
                ))}
              </span>
              <strong>답글 {message.thread.replyCount}개</strong>
              <span className="muted">마지막 답글 {timeFormat.format(new Date(message.thread.lastReplyAt))}</span>
            </button>
          )}
        </div>
        {canInteract && !message.deleted && !editing && (
          <div className="actions" role="toolbar" aria-label="메시지 동작">
            <button title="반응 추가" aria-label="반응 추가" onClick={() => setPicking((p) => !p)}>
              ☺
            </button>
            <button title={saved ? "저장 취소" : "저장"} aria-label={saved ? "저장 취소" : "저장"} aria-pressed={saved} onClick={() => void toggleSaved()}>
              {saved ? "🔖" : "📑"}
            </button>
            {onOpenThread && message.parentId === null && (
              <button title="스레드에 답글" aria-label="스레드에 답글" onClick={() => onOpenThread(message.id)}>
                💬
              </button>
            )}
            {mine && (
              <>
                <button title="수정" aria-label="수정" onClick={() => setEditing(true)}>
                  ✎
                </button>
                <button title="삭제" aria-label="삭제" onClick={() => void remove()}>
                  🗑
                </button>
              </>
            )}
            {picking && (
              <div className="emoji-picker" role="menu">
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} role="menuitem" aria-label={`${emoji} 반응`} onClick={() => void toggleReaction(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </article>
    </>
  );
}

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const qc = useQueryClient();
  const { names } = useDirectory();
  const initial = useRef(toDisplay(message.text, names));
  const picked = useRef<MentionMap>(initial.current.picked);
  const [text, setText] = useState(initial.current.text);
  const [error, setError] = useState(false);

  const save = async () => {
    const body = toTokens(text.trim(), picked.current);
    if (!body) return;
    if (body === message.text) return onDone();
    try {
      replaceMessage(qc, await api.editMessage(message.id, body));
      onDone();
    } catch {
      setError(true);
    }
  };

  return (
    <div className="edit-box">
      <MentionTextarea value={text} onChange={setText} onSubmit={() => void save()} onCancel={onDone} picked={picked.current} autoFocus />
      <p className="hint muted">
        {error ? <span className="error">저장 실패</span> : "Enter 저장 · Esc 취소"}
        <button className="link" onClick={onDone}>
          취소
        </button>
        <button className="link" onClick={() => void save()}>
          저장
        </button>
      </p>
    </div>
  );
}
