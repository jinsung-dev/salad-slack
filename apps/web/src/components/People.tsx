import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PresenceStatus } from "@chatter/shared";
import { api } from "../api";
import { keys } from "../cache";
import { useDirectory } from "../directory";
import { useCurrentWorkspace } from "../workspace";

export function usePresence(userId: string | undefined): PresenceStatus {
  const { id } = useCurrentWorkspace();
  const presence = useQuery({ queryKey: keys.presence(id), queryFn: () => api.presence(id), refetchInterval: 60_000 });
  return (userId && presence.data?.[userId]) || "offline";
}

const PRESENCE_LABEL: Record<PresenceStatus, string> = { active: "온라인", away: "자리 비움", offline: "오프라인" };

export function PresenceDot({ userId }: { userId: string | undefined }) {
  const status = usePresence(userId);
  return <span className={`presence presence-${status}`} title={PRESENCE_LABEL[status]} aria-label={PRESENCE_LABEL[status]} />;
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return <span className={`avatar avatar-${size}`}>{name.slice(0, 1).toUpperCase()}</span>;
}

/** Modal multi-select of workspace members. */
export function UserPicker({
  title,
  confirmLabel,
  exclude,
  max,
  onConfirm,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  exclude: string[];
  max: number;
  onConfirm: (userIds: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const { users } = useDirectory();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = users.filter((u) => !exclude.includes(u.id) && u.displayName.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < max ? [...s, id] : s));

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(selected);
      onClose();
    } catch {
      setError("요청에 실패했습니다.");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>{title}</h2>
        <input placeholder="이름으로 찾기" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <ul className="picker-list">
          {candidates.map((u) => (
            <li key={u.id}>
              <label>
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
                <PresenceDot userId={u.id} />
                {u.displayName}
                {u.role === "guest" && <span className="guest-badge">게스트</span>}
                {u.isBot && <span className="bot-badge">앱</span>}
              </label>
            </li>
          ))}
          {candidates.length === 0 && <li className="muted">일치하는 사람이 없습니다.</li>}
        </ul>
        <p className="muted hint">
          {selected.length}/{max}명 선택
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button className="link" onClick={onClose}>
            취소
          </button>
          <button onClick={confirm} disabled={busy || selected.length === 0}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
