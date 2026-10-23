import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { MAX_DM_MEMBERS, channelNameSchema, type Channel, type User } from "@chatter/shared";
import { ApiError, api } from "../api";
import { upsertChannel } from "../cache";
import { endSession } from "../session";
import { channelLabel, useDirectory } from "../directory";
import { useConnectionStatus } from "../realtime";
import { Avatar, PresenceDot, UserPicker } from "./People";

const STATUS_LABEL = { open: "연결됨", connecting: "연결 중…", closed: "재연결 대기" } as const;

export function Sidebar({ me, channels, activeId }: { me: User; channels: Channel[]; activeId: string | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useConnectionStatus();
  const { names } = useDirectory();
  const [creating, setCreating] = useState(false);
  const [startingDm, setStartingDm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byLabel = (a: Channel, b: Channel) => channelLabel(a, names, me.id).localeCompare(channelLabel(b, names, me.id));
  const joined = channels.filter((c) => c.isMember && c.kind !== "dm").sort(byLabel);
  const dms = channels.filter((c) => c.kind === "dm").sort(byLabel);
  const browsable = channels.filter((c) => !c.isMember).sort(byLabel);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = channelNameSchema.safeParse(form.get("name"));
    if (!name.success) return setError(name.error.issues[0]?.message ?? "잘못된 이름");
    try {
      const channel = await api.createChannel({ name: name.data, isPrivate: form.get("private") === "on" });
      upsertChannel(qc, channel);
      setCreating(false);
      setError(null);
      navigate(`/c/${channel.id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "channel_name_taken" ? "이미 있는 채널 이름입니다." : "생성 실패");
    }
  };

  const startDm = async (userIds: string[]) => {
    const channel = await api.createDm(userIds);
    upsertChannel(qc, channel);
    navigate(`/c/${channel.id}`);
  };

  const logout = async () => {
    await api.logout();
    endSession(qc);
    navigate("/login", { replace: true });
  };

  const item = (c: Channel) => {
    const label = channelLabel(c, names, me.id);
    const peer = c.kind === "dm" && c.memberIds?.length === 2 ? c.memberIds.find((id) => id !== me.id) : undefined;
    // DMs badge every unread message; channels badge only mentions.
    const badge = c.id === activeId ? 0 : c.kind === "dm" ? c.unreadCount : c.mentionCount;
    return (
      <li key={c.id}>
        <Link
          to={`/c/${c.id}`}
          className={["channel-link", c.id === activeId && "active", (c.unreadCount > 0 || badge > 0) && c.id !== activeId && "unread"]
            .filter(Boolean)
            .join(" ")}
        >
          <span className="hash">{c.kind === "dm" ? peer ? <PresenceDot userId={peer} /> : "👥" : c.kind === "private" ? "🔒" : "#"}</span>
          <span className="name">{label}</span>
          {badge > 0 && <span className="badge">{badge}</span>}
        </Link>
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <strong>Chatter</strong>
        <span className={`status status-${status}`} title={STATUS_LABEL[status]} />
      </header>

      <nav>
        <h2>채널</h2>
        <ul>{joined.map(item)}</ul>
        {creating ? (
          <form className="new-channel" onSubmit={create}>
            <input name="name" placeholder="새-채널-이름 (예: 개발팀)" autoFocus />
            <label className="hint">
              <input type="checkbox" name="private" /> 비공개 채널
            </label>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <button type="submit">만들기</button>
              <button type="button" className="link" onClick={() => (setCreating(false), setError(null))}>
                취소
              </button>
            </div>
          </form>
        ) : (
          <button className="add" onClick={() => setCreating(true)}>
            + 채널 만들기
          </button>
        )}

        <h2>다이렉트 메시지</h2>
        <ul>{dms.map(item)}</ul>
        <button className="add" onClick={() => setStartingDm(true)}>
          + 새 메시지
        </button>

        {browsable.length > 0 && (
          <>
            <h2>둘러보기</h2>
            <ul className="browse">{browsable.map(item)}</ul>
          </>
        )}
      </nav>

      <footer className="sidebar-footer">
        <Avatar name={me.displayName} size="sm" />
        <PresenceDot userId={me.id} />
        <span className="me">{me.displayName}</span>
        <button className="link" onClick={logout}>
          로그아웃
        </button>
      </footer>

      {startingDm && (
        <UserPicker
          title="새 메시지"
          confirmLabel="대화 시작"
          exclude={[]}
          max={MAX_DM_MEMBERS - 1}
          onConfirm={startDm}
          onClose={() => setStartingDm(false)}
        />
      )}
    </aside>
  );
}
