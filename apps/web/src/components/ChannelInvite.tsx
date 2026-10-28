import { useState, type FormEvent } from "react";
import type { Channel, Invite } from "@chatter/shared";
import { ApiError, api } from "../api";
import { CopyField } from "./CopyField";

const DURATIONS = [
  { days: null, label: "기간 없음" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
  { days: 90, label: "90일" },
] as const;

/** An outside guest for one channel: the link adds them to it and nowhere else. */
export function ChannelInviteDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [created, setCreated] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const days = String(form.get("days") ?? "");
    setError(null);
    try {
      setCreated(await api.createInvite(channel.workspaceId, { role: "guest", channelId: channel.id, email, guestDays: days ? Number(days) : null }));
    } catch (err) {
      setError(err instanceof ApiError && err.code === "invalid_input" ? "이메일 형식을 확인해 주세요." : "초대를 만들지 못했습니다.");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="외부인 초대" onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>#{channel.name}에 외부인 초대</h2>
        <p className="muted hint">
          게스트로 참여하며 이 채널만 볼 수 있습니다. 링크는 7일 동안 그 이메일 주소로 한 번 쓸 수 있고, 회사 밖 사람은 그 주소로 받은 코드로 로그인합니다.
        </p>
        {created?.url ? (
          <>
            <p>초대 링크입니다. 지금만 볼 수 있으니 복사해서 {created.email}에게 전달하세요.</p>
            <CopyField value={created.url} label="채널 초대 링크" />
          </>
        ) : (
          <form onSubmit={create} className="stack">
            <label>
              게스트 기간
              <select name="days" aria-label="게스트 기간" defaultValue="30">
                {DURATIONS.map((d) => (
                  <option key={d.label} value={d.days ?? ""}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              초대할 사람의 이메일
              <input name="email" type="email" required placeholder="partner@example.com" />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit">초대 링크 만들기</button>
          </form>
        )}
        <div className="row end">
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
