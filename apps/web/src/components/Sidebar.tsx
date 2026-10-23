import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { MAX_DM_MEMBERS, channelNameSchema, type Channel, type User } from "@chatter/shared";
import { ApiError, api } from "../api";
import { keys, upsertChannel } from "../cache";
import { endSession } from "../session";
import { channelLabel, useDirectory } from "../directory";
import { useConnectionStatus } from "../realtime";
import { Avatar, PresenceDot, UserPicker } from "./People";
import { SettingsDialog } from "./Settings";
import { useCurrentWorkspace, workspacePath } from "../workspace";

const STATUS_LABEL = { open: "연결됨", connecting: "연결 중…", closed: "재연결 대기" } as const;

export function Sidebar({ me, channels, activeId }: { me: User; channels: Channel[]; activeId: string | undefined }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useConnectionStatus();
  const { names } = useDirectory();
  const workspace = useCurrentWorkspace();
  const at = (rest: string) => workspacePath(workspace.id, rest);
  const isGuest = workspace.role === "guest";
  const [creating, setCreating] = useState(false);
  const [startingDm, setStartingDm] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      const channel = await api.createChannel(workspace.id, { name: name.data, isPrivate: form.get("private") === "on" });
      upsertChannel(qc, channel);
      setCreating(false);
      setError(null);
      navigate(at(`/c/${channel.id}`));
    } catch (err) {
      setError(err instanceof ApiError && err.code === "channel_name_taken" ? "이미 있는 채널 이름입니다." : "생성 실패");
    }
  };

  const startDm = async (userIds: string[]) => {
    const channel = await api.createDm(workspace.id, userIds);
    upsertChannel(qc, channel);
    navigate(at(`/c/${channel.id}`));
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
          to={at(`/c/${c.id}`)}
          className={[
            "channel-link",
            c.id === activeId && "active",
            c.notify === "none" && "muted-channel",
            // Muted conversations stay quiet unless someone mentions you.
            ((c.unreadCount > 0 && c.notify !== "none") || badge > 0) && c.id !== activeId && "unread",
          ]
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
        <WorkspaceSwitcher />
        <span className={`status status-${status}`} title={STATUS_LABEL[status]} />
      </header>

      <form
        className="search-box"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
          if (q) navigate(at(`/search?q=${encodeURIComponent(q)}`));
        }}
      >
        <input name="q" type="search" placeholder="메시지 검색" aria-label="메시지 검색" />
      </form>

      <nav>
        <Link to={at("/saved")} className="channel-link saved-link">
          <span className="hash">🔖</span>
          <span className="name">저장한 메시지</span>
        </Link>
        <h2>채널</h2>
        <ul>{joined.map(item)}</ul>
        {isGuest ? null : creating ? (
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
        {!isGuest && (
          <button className="add" onClick={() => setStartingDm(true)}>
            + 새 메시지
          </button>
        )}

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
        <button className="link" onClick={() => setSettingsOpen(true)}>
          설정
        </button>
        <button className="link" onClick={logout}>
          로그아웃
        </button>
      </footer>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
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

const ROLE_LABEL = { owner: "소유자", admin: "관리자", member: "멤버", guest: "게스트" } as const;

/** The current workspace's name; opens a menu to switch, start one, or manage this one. */
function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const current = useCurrentWorkspace();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  const [open, setOpen] = useState(false);
  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };
  return (
    <div className="switcher">
      <button className="switcher-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <strong>{current.name}</strong> ▾
      </button>
      {open && (
        <div className="switcher-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          <p className="muted hint">{ROLE_LABEL[current.role]}</p>
          <button role="menuitem" onClick={() => go(workspacePath(current.id, "/admin"))}>
            {current.role === "owner" || current.role === "admin" ? "워크스페이스 관리" : "멤버 보기"}
          </button>
          <hr />
          {(workspaces.data ?? [])
            .filter((w) => w.id !== current.id)
            .map((w) => (
              <button key={w.id} role="menuitem" onClick={() => go(workspacePath(w.id))}>
                {w.name}
              </button>
            ))}
          <button role="menuitem" onClick={() => go("/new")}>
            + 워크스페이스 추가
          </button>
        </div>
      )}
    </div>
  );
}
