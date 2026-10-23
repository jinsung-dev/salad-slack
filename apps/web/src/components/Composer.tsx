import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { appendMessage } from "../cache";
import { nameOf, toTokens, useDirectory, type MentionMap } from "../directory";
import { useSendEvent, useTyping } from "../realtime";
import { MentionTextarea } from "./MentionTextarea";

const TYPING_EVERY_MS = 3_000;

export function Composer({
  channelId,
  parentId = null,
  placeholder,
}: {
  channelId: string;
  parentId?: number | null;
  placeholder: string;
}) {
  const qc = useQueryClient();
  const send = useSendEvent();
  const [text, setText] = useState("");
  const [alsoToChannel, setAlsoToChannel] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const picked = useRef<MentionMap>(new Map());
  // Kept until the server accepts the message, so a retry reuses the same key.
  const pendingId = useRef<string | null>(null);
  const lastTyping = useRef(0);

  const submit = async () => {
    const body = toTokens(text.trim(), picked.current);
    if (!body || sending) return;
    pendingId.current ??= crypto.randomUUID();
    setSending(true);
    setFailed(false);
    try {
      const message = await api.postMessage(channelId, {
        text: body,
        clientMsgId: pendingId.current,
        ...(parentId === null ? {} : { parentId, alsoSendToChannel: alsoToChannel }),
      });
      appendMessage(qc, message);
      pendingId.current = null;
      picked.current.clear();
      setText("");
      setAlsoToChannel(false);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const onChange = (value: string) => {
    setText(value);
    pendingId.current = null;
    if (value && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = Date.now();
      send({ type: "typing", channelId, parentId });
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <MentionTextarea value={text} onChange={onChange} onSubmit={() => void submit()} picked={picked.current} placeholder={placeholder} autoFocus />
        <div className="composer-footer">
          {parentId !== null ? (
            <label className="hint">
              <input type="checkbox" checked={alsoToChannel} onChange={(e) => setAlsoToChannel(e.target.checked)} /> 채널에도 보내기
            </label>
          ) : (
            <span className="muted hint">
              {failed ? <span className="error">전송 실패 — Enter로 다시 시도</span> : "*굵게* _기울임_ `코드` @멘션 · Shift+Enter 줄바꿈"}
            </span>
          )}
          <button onClick={() => void submit()} disabled={sending || !text.trim()}>
            보내기
          </button>
        </div>
      </div>
      <TypingIndicator channelId={channelId} parentId={parentId} />
    </div>
  );
}

function TypingIndicator({ channelId, parentId }: { channelId: string; parentId: number | null }) {
  const { names } = useDirectory();
  const users = useTyping(channelId, parentId);
  const label =
    users.length === 0
      ? " "
      : users.length === 1
        ? `${nameOf(names, users[0]!)} 님이 입력 중…`
        : `${users.length}명이 입력 중…`;
  return (
    <p className="typing muted" aria-live="polite">
      {label}
    </p>
  );
}
