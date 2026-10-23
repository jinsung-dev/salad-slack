import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotifyLevel, Preferences } from "@chatter/shared";
import { api } from "../api";
import { updateChannel } from "../cache";
import { disablePush, enablePush, pushState, type PushState } from "../notifications";

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "이 브라우저는 알림을 지원하지 않습니다.",
  "disabled-by-server": "서버에 알림이 설정되어 있지 않습니다.",
  denied: "브라우저에서 알림이 차단되어 있습니다. 주소창의 사이트 설정에서 허용해 주세요.",
  off: "꺼짐",
  on: "켜짐 — Chatter를 보고 있지 않을 때 멘션과 DM을 알려드립니다.",
};

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["preferences"], queryFn: api.preferences });
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);
  useEffect(() => {
    if (prefs.data && !draft) {
      // Follow the browser's time zone unless the person changes it.
      setDraft({ ...prefs.data, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || prefs.data.timeZone });
    }
  }, [prefs.data, draft]);

  const togglePush = async () => {
    setError(null);
    try {
      setPush(push === "on" ? await disablePush() : await enablePush());
    } catch {
      setError("알림 설정을 바꾸지 못했습니다.");
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.savePreferences(draft);
      qc.setQueryData(["preferences"], draft);
      onClose();
    } catch {
      setError("저장하지 못했습니다.");
      setSaving(false);
    }
  };

  const quiet = draft?.quietHours;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="설정" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>설정</h2>

        <section className="setting">
          <h3>데스크톱 알림</h3>
          <p className="muted">{push ? PUSH_LABEL[push] : "확인 중…"}</p>
          {(push === "on" || push === "off") && (
            <button className="secondary" onClick={() => void togglePush()}>
              {push === "on" ? "알림 끄기" : "알림 켜기"}
            </button>
          )}
        </section>

        <section className="setting">
          <h3>방해 금지 시간</h3>
          {!draft && <p className="muted">불러오는 중…</p>}
          {quiet && draft && (
            <>
              <label className="row">
                <input
                  type="checkbox"
                  checked={quiet.enabled}
                  onChange={(e) => setDraft({ ...draft, quietHours: { ...quiet, enabled: e.target.checked } })}
                />
                매일 이 시간에는 알림을 보내지 않음
              </label>
              <div className="row">
                <input
                  type="time"
                  aria-label="시작"
                  value={quiet.start}
                  disabled={!quiet.enabled}
                  onChange={(e) => setDraft({ ...draft, quietHours: { ...quiet, start: e.target.value } })}
                />
                ~
                <input
                  type="time"
                  aria-label="종료"
                  value={quiet.end}
                  disabled={!quiet.enabled}
                  onChange={(e) => setDraft({ ...draft, quietHours: { ...quiet, end: e.target.value } })}
                />
              </div>
              <p className="muted hint">시간대: {draft.timeZone}</p>
            </>
          )}
        </section>

        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button className="link" onClick={onClose}>
            닫기
          </button>
          <button onClick={() => void save()} disabled={!draft || saving}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

const LEVEL_LABEL: Record<NotifyLevel, string> = { all: "모든 메시지", mentions: "멘션만", none: "끄기" };

/** The viewer's notification level for one conversation. */
export function NotifySelect({ channelId, level }: { channelId: string; level: NotifyLevel }) {
  const qc = useQueryClient();
  const change = async (next: NotifyLevel) => {
    updateChannel(qc, channelId, (c) => ({ ...c, notify: next }));
    try {
      await api.setNotify(channelId, next);
    } catch {
      updateChannel(qc, channelId, (c) => ({ ...c, notify: level }));
    }
  };
  return (
    <label className="notify-select">
      <span className="muted">알림</span>
      <select value={level} onChange={(e) => void change(e.target.value as NotifyLevel)} aria-label="알림 수준">
        {(Object.keys(LEVEL_LABEL) as NotifyLevel[]).map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
