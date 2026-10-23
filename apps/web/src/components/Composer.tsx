import { useEffect, useRef, useState, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_FILES_PER_MESSAGE, type FileRef } from "@chatter/shared";
import { ApiError, api } from "../api";
import { appendMessage } from "../cache";
import { nameOf, toTokens, useDirectory, type MentionMap } from "../directory";
import { useSendEvent, useTyping } from "../realtime";
import { MentionTextarea } from "./MentionTextarea";
import { formatBytes } from "./Files";

const TYPING_EVERY_MS = 3_000;

interface Attachment {
  key: string;
  file: File;
  /** Object URL for image thumbnails. */
  preview: string | null;
  state: "uploading" | "done" | "error";
  ref?: FileRef;
  error?: string;
}

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [alsoToChannel, setAlsoToChannel] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picked = useRef<MentionMap>(new Map());
  const fileInput = useRef<HTMLInputElement>(null);
  // Kept until the server accepts the message, so a retry reuses the same key.
  const pendingId = useRef<string | null>(null);
  const lastTyping = useRef(0);

  // Release thumbnails when the composer goes away.
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const patch = (key: string, change: Partial<Attachment>) =>
    setAttachments((list) => list.map((a) => (a.key === key ? { ...a, ...change } : a)));

  const addFiles = (files: Iterable<File>) => {
    const room = MAX_FILES_PER_MESSAGE - attachments.length;
    for (const file of [...files].slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID();
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      setAttachments((list) => [...list, { key, file, preview, state: "uploading" }]);
      pendingId.current = null;
      api
        .uploadFile(channelId, file)
        .then((ref) => patch(key, { state: "done", ref }))
        .catch((err: unknown) =>
          patch(key, {
            state: "error",
            error: err instanceof ApiError && err.code === "file_too_large" ? "파일이 너무 큽니다" : "업로드 실패",
          }),
        );
    }
  };

  const removeAttachment = (key: string) => {
    setAttachments((list) => list.filter((a) => a.key !== key));
    pendingId.current = null;
  };

  const uploading = attachments.some((a) => a.state === "uploading");
  const ready = attachments.filter((a) => a.state === "done").map((a) => a.ref!);

  const submit = async () => {
    const body = toTokens(text.trim(), picked.current);
    if ((!body && ready.length === 0) || sending || uploading) return;
    pendingId.current ??= crypto.randomUUID();
    setSending(true);
    setFailed(false);
    try {
      const message = await api.postMessage(channelId, {
        text: body,
        clientMsgId: pendingId.current,
        fileIds: ready.map((f) => f.id),
        ...(parentId === null ? {} : { parentId, alsoSendToChannel: alsoToChannel }),
      });
      appendMessage(qc, message);
      pendingId.current = null;
      picked.current.clear();
      setText("");
      setAttachments([]);
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

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="composer-wrap"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onPaste={(e) => {
        if (e.clipboardData.files.length > 0) {
          e.preventDefault();
          addFiles(e.clipboardData.files);
        }
      }}
    >
      <div className={dragging ? "composer dragging" : "composer"}>
        {attachments.length > 0 && (
          <ul className="attachments" aria-label="첨부 파일">
            {attachments.map((a) => (
              <li key={a.key} className={`attachment ${a.state}`}>
                {a.preview ? <img src={a.preview} alt="" /> : <span className="file-icon">📄</span>}
                <span className="attachment-name">
                  {a.file.name}
                  <small className="muted">
                    {a.state === "uploading" ? "올리는 중…" : a.state === "error" ? a.error : formatBytes(a.file.size)}
                  </small>
                </span>
                <button className="link" aria-label={`${a.file.name} 빼기`} onClick={() => removeAttachment(a.key)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <MentionTextarea value={text} onChange={onChange} onSubmit={() => void submit()} picked={picked.current} placeholder={placeholder} autoFocus />
        <div className="composer-footer">
          <div className="row">
            <button className="icon" title="파일 첨부" aria-label="파일 첨부" onClick={() => fileInput.current?.click()}>
              📎
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {parentId !== null ? (
              <label className="hint">
                <input type="checkbox" checked={alsoToChannel} onChange={(e) => setAlsoToChannel(e.target.checked)} /> 채널에도 보내기
              </label>
            ) : (
              <span className="muted hint">
                {failed ? <span className="error">전송 실패 — Enter로 다시 시도</span> : "*굵게* _기울임_ `코드` @멘션 · 파일은 끌어다 놓기"}
              </span>
            )}
          </div>
          <button onClick={() => void submit()} disabled={sending || uploading || (!text.trim() && ready.length === 0)}>
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
