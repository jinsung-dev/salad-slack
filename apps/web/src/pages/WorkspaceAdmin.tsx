import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import {
  appEventTypes,
  appScopes,
  slackId,
  type App,
  type AppEventType,
  type AppScope,
  type GrantableRole,
  type Invite,
  type User,
  type Webhook,
  type WorkspaceRole,
} from "@chatter/shared";
import { ApiError, api } from "../api";
import { forgetWorkspace, keys } from "../cache";
import { useDirectory } from "../directory";
import { CopyField } from "../components/CopyField";
import { useCurrentWorkspace, workspacePath } from "../workspace";

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "소유자", admin: "관리자", member: "멤버", guest: "게스트" };
const dateFormat = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

export function WorkspaceAdmin({ me }: { me: User }) {
  const workspace = useCurrentWorkspace();
  const canManage = workspace.role === "owner" || workspace.role === "admin";
  return (
    <div className="admin">
      <header className="admin-header">
        <Link to={workspacePath(workspace.id)} className="link">
          ← {workspace.name}(으)로 돌아가기
        </Link>
        <h1>{canManage ? "워크스페이스 관리" : "멤버"}</h1>
      </header>
      <Members me={me} />
      {canManage && <Invites />}
      {canManage && <Webhooks />}
      {canManage && <Apps me={me} />}
      {canManage && <WorkspaceSettings />}
    </div>
  );
}

function Members({ me }: { me: User }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workspace = useCurrentWorkspace();
  const { users } = useDirectory();
  const [error, setError] = useState<string | null>(null);
  const mine = workspace.role;
  // Mirrors the server's rules so only allowed actions are offered; the server still decides.
  const canEdit = (role: WorkspaceRole) => role !== "owner" && (mine === "owner" || (mine === "admin" && role !== "admin"));

  const changeRole = async (userId: string, role: GrantableRole) => {
    setError(null);
    try {
      await api.setRole(workspace.id, userId, role);
    } catch {
      setError("역할을 바꾸지 못했습니다.");
    }
  };
  const remove = async (userId: string, name: string) => {
    if (!confirm(`${name} 님을 워크스페이스에서 내보낼까요? 이 워크스페이스의 대화에 더 이상 접근할 수 없습니다.`)) return;
    await api.removeMember(workspace.id, userId).catch(() => setError("내보내지 못했습니다."));
  };
  const leave = async () => {
    if (!confirm(`${workspace.name}에서 나갈까요?`)) return;
    await api.removeMember(workspace.id, me.id);
    forgetWorkspace(qc, workspace.id);
    navigate("/", { replace: true });
  };

  return (
    <section className="admin-section">
      <h2>멤버 {users.length}명</h2>
      {error && <p className="error">{error}</p>}
      <table className="admin-table">
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.displayName}
                {u.id === me.id && <span className="muted"> (나)</span>}
                {u.expiresAt && <span className="muted"> · {dateFormat.format(new Date(u.expiresAt))}까지</span>}
              </td>
              <td>
                {u.guestOnly ? (
                  // Outside guests sign in with an emailed code and stay guests.
                  <span title="회사 밖 게스트: 이메일 코드로 로그인하며 역할을 바꿀 수 없습니다">외부 게스트</span>
                ) : canEdit(u.role) && u.id !== me.id ? (
                  <select aria-label={`${u.displayName} 역할`} value={u.role} onChange={(e) => void changeRole(u.id, e.target.value as GrantableRole)}>
                    {mine === "owner" && <option value="admin">관리자</option>}
                    <option value="member">멤버</option>
                    <option value="guest">게스트</option>
                  </select>
                ) : (
                  ROLE_LABEL[u.role]
                )}
              </td>
              <td className="actions-cell">
                {u.id === me.id
                  ? u.role !== "owner" && (
                      <button className="link danger" onClick={() => void leave()}>
                        나가기
                      </button>
                    )
                  : canEdit(u.role) && (
                      <button className="link danger" onClick={() => void remove(u.id, u.displayName)}>
                        내보내기
                      </button>
                    )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function inviteStatus(i: Invite) {
  if (i.revokedAt) return "취소됨";
  if (i.usedAt) return "사용됨";
  if (new Date(i.expiresAt) < new Date()) return "만료됨";
  return `유효 · ${dateFormat.format(new Date(i.expiresAt))}까지`;
}

function Invites() {
  const qc = useQueryClient();
  const workspace = useCurrentWorkspace();
  const channels = useQuery({ queryKey: keys.channels(workspace.id), queryFn: () => api.channels(workspace.id) });
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "삭제된 채널";
  const list = useQuery({ queryKey: ["invites", workspace.id], queryFn: () => api.invites(workspace.id), staleTime: 0 });
  const [created, setCreated] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    setError(null);
    try {
      setCreated(await api.createInvite(workspace.id, { role: form.get("role") as GrantableRole, email: email || null }));
      void qc.invalidateQueries({ queryKey: ["invites", workspace.id] });
    } catch (err) {
      setError(err instanceof ApiError && err.code === "invalid_input" ? "이메일 형식을 확인해 주세요." : "초대를 만들지 못했습니다.");
    }
  };

  return (
    <section className="admin-section">
      <h2>초대</h2>
      <p className="muted hint">링크는 7일 동안 유효합니다. 이메일을 지정하면 그 계정만, 한 번만 쓸 수 있습니다.</p>
      <form onSubmit={create} className="row wrap">
        <select name="role" aria-label="초대 역할" defaultValue="member">
          {workspace.role === "owner" && <option value="admin">관리자</option>}
          <option value="member">멤버</option>
          <option value="guest">게스트</option>
        </select>
        <input name="email" type="email" placeholder="이메일 (선택)" aria-label="초대할 이메일" />
        <button type="submit">초대 링크 만들기</button>
      </form>
      {error && <p className="error">{error}</p>}
      {created?.url && (
        <div className="created">
          <p>새 초대 링크입니다. 지금만 볼 수 있으니 복사해서 전달하세요.</p>
          <CopyField value={created.url} label="초대 링크" />
        </div>
      )}
      <table className="admin-table">
        <tbody>
          {(list.data ?? []).map((i) => (
            <tr key={i.id}>
              <td>
                {ROLE_LABEL[i.role]}
                {i.guestDays && <span className="muted"> · {i.guestDays}일</span>}
              </td>
              <td>
                {i.email ?? "누구나"}
                {i.channelId && <span className="muted"> → #{channelName(i.channelId)}</span>}
              </td>
              <td className="muted">{inviteStatus(i)}</td>
              <td className="actions-cell">
                {!i.revokedAt && !i.usedAt && new Date(i.expiresAt) > new Date() && (
                  <button
                    className="link danger"
                    onClick={() => void api.revokeInvite(workspace.id, i.id).then(() => qc.invalidateQueries({ queryKey: ["invites", workspace.id] }))}
                  >
                    취소
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Webhooks() {
  const qc = useQueryClient();
  const workspace = useCurrentWorkspace();
  const channels = useQuery({ queryKey: keys.channels(workspace.id), queryFn: () => api.channels(workspace.id) });
  const list = useQuery({ queryKey: ["webhooks", workspace.id], queryFn: () => api.webhooks(workspace.id), staleTime: 0 });
  const [created, setCreated] = useState<Webhook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = (channels.data ?? []).filter((c) => c.kind !== "dm");
  const nameOf = (id: string) => targets.find((c) => c.id === id)?.name ?? "삭제된 채널";

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError(null);
    try {
      setCreated(await api.createWebhook(workspace.id, String(form.get("channel")), String(form.get("name") ?? "").trim()));
      void qc.invalidateQueries({ queryKey: ["webhooks", workspace.id] });
    } catch {
      setError("웹훅을 만들지 못했습니다. 채널과 이름을 확인해 주세요.");
    }
  };

  return (
    <section className="admin-section">
      <h2>수신 웹훅</h2>
      <p className="muted hint">URL로 JSON을 보내면 채널에 메시지가 올라옵니다. URL이 곧 비밀번호이니 공개하지 마세요.</p>
      <form onSubmit={create} className="row wrap">
        <select name="channel" aria-label="웹훅 채널" required>
          {targets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.kind === "private" ? "🔒" : "#"}
              {c.name}
            </option>
          ))}
        </select>
        <input name="name" placeholder="표시 이름 (예: 배포 알림)" aria-label="웹훅 이름" required maxLength={80} />
        <button type="submit" disabled={targets.length === 0}>
          웹훅 만들기
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {created?.url && (
        <div className="created">
          <p>새 웹훅 URL입니다. 지금만 볼 수 있습니다.</p>
          <CopyField value={created.url} label="웹훅 URL" />
          <pre className="example">{`curl -X POST -H 'content-type: application/json' \\\n  -d '{"text":"배포 완료"}' ${created.url}`}</pre>
        </div>
      )}
      <table className="admin-table">
        <tbody>
          {(list.data ?? []).map((h) => (
            <tr key={h.id}>
              <td>{h.name}</td>
              <td>#{nameOf(h.channelId)}</td>
              <td className="muted">{dateFormat.format(new Date(h.createdAt))}</td>
              <td className="actions-cell">
                <button
                  className="link danger"
                  onClick={() => {
                    if (confirm(`${h.name} 웹훅을 삭제할까요? URL이 더 이상 동작하지 않습니다.`)) {
                      void api.revokeWebhook(workspace.id, h.id).then(() => qc.invalidateQueries({ queryKey: ["webhooks", workspace.id] }));
                    }
                  }}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function WorkspaceSettings() {
  const qc = useQueryClient();
  const workspace = useCurrentWorkspace();
  const [message, setMessage] = useState<string | null>(null);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const domain = String(form.get("domain") ?? "").trim();
    try {
      await api.updateWorkspace(workspace.id, name, domain || null);
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      setMessage("저장했습니다.");
    } catch {
      setMessage("저장하지 못했습니다. 이름과 도메인 형식을 확인해 주세요.");
    }
  };

  return (
    <section className="admin-section">
      <h2>설정</h2>
      <form onSubmit={save} className="stack narrow">
        <label>
          이름
          <input name="name" defaultValue={workspace.name} required maxLength={80} />
        </label>
        <label>
          가입 허용 도메인
          <input name="domain" defaultValue={workspace.joinDomain ?? ""} placeholder="example.com (비우면 초대로만 참여)" />
        </label>
        <button type="submit">저장</button>
        {message && <p className="muted">{message}</p>}
      </form>
    </section>
  );
}

const SCOPE_LABEL: Record<AppScope, string> = {
  "chat:write": "chat:write — 들어가 있는 채널에 메시지 보내기",
  "channels:read": "channels:read — 채널 목록 보기",
  "channels:history": "channels:history — 들어가 있는 채널의 메시지 읽기",
  "users:read": "users:read — 멤버 목록 보기",
};
const EVENT_LABEL: Record<AppEventType, string> = {
  message: "message — 봇이 있는 채널의 새 메시지",
  app_mention: "app_mention — 봇을 멘션한 메시지",
};

function Apps({ me }: { me: User }) {
  const qc = useQueryClient();
  const workspace = useCurrentWorkspace();
  const list = useQuery({ queryKey: ["apps", workspace.id], queryFn: () => api.apps(workspace.id), staleTime: 0 });
  const [issued, setIssued] = useState<App | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["apps", workspace.id] });
    void qc.invalidateQueries({ queryKey: ["commands", workspace.id] });
  };

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    setError(null);
    try {
      setIssued(await api.createApp(workspace.id, name));
      form.reset();
      void refresh();
      void qc.invalidateQueries({ queryKey: keys.members(workspace.id) });
    } catch {
      setError("앱을 만들지 못했습니다.");
    }
  };

  return (
    <section className="admin-section">
      <h2>앱</h2>
      <p className="muted hint">
        앱은 봇 토큰으로 API를 쓰고, 이벤트와 슬래시 커맨드, 버튼 클릭을 앱 서버로 받습니다. 봇을 채널에 넣으려면 채널에서 &quot;사람 추가&quot;로 추가하세요.
      </p>
      <form onSubmit={create} className="row wrap">
        <input name="name" placeholder="앱 이름 (예: 배포 봇)" aria-label="앱 이름" required maxLength={80} />
        <button type="submit">앱 만들기</button>
      </form>
      {error && <p className="error">{error}</p>}
      {issued?.token && (
        <div className="created">
          <p>
            <strong>{issued.name}</strong>의 봇 토큰입니다. 지금만 볼 수 있습니다.
          </p>
          <CopyField value={issued.token} label="봇 토큰" />
        </div>
      )}
      {issued?.appToken && (
        <div className="created">
          <p>
            <strong>{issued.name}</strong>의 앱 토큰(Socket Mode 연결용)입니다. 지금만 볼 수 있습니다.
          </p>
          <CopyField value={issued.appToken} label="앱 토큰" />
        </div>
      )}
      {(list.data ?? []).map((a) => (
        <AppCard key={a.id} app={a} me={me} onIssued={setIssued} onChanged={() => void refresh()} />
      ))}
    </section>
  );
}

function AppCard({ app, me, onIssued, onChanged }: { app: App; me: User; onIssued: (a: App) => void; onChanged: () => void }) {
  const workspace = useCurrentWorkspace();
  const [message, setMessage] = useState<string | null>(null);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const url = (key: string) => String(form.get(key) ?? "").trim() || null;
    try {
      await api.updateApp(workspace.id, app.id, {
        name: String(form.get("name") ?? "").trim(),
        scopes: appScopes.filter((s) => form.get(`scope:${s}`) === "on"),
        eventsUrl: url("eventsUrl"),
        eventTypes: appEventTypes.filter((t) => form.get(`event:${t}`) === "on"),
        interactivityUrl: url("interactivityUrl"),
        socketMode: form.get("socketMode") === "on",
      });
      setMessage("저장했습니다.");
      onChanged();
    } catch {
      setMessage("저장하지 못했습니다. URL은 https://로 시작해야 합니다.");
    }
  };

  const addCommand = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    try {
      await api.addCommand(workspace.id, app.id, {
        command: String(form.get("command") ?? "").replace(/^\//, "").trim(),
        url: String(form.get("url") ?? "").trim() || null,
        description: String(form.get("description") ?? "").trim(),
        usageHint: String(form.get("usageHint") ?? "").trim(),
      });
      formEl.reset();
      setMessage(null);
      onChanged();
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.code === "command_taken"
          ? "이미 있는 명령입니다."
          : err instanceof ApiError && err.code === "command_url_required"
            ? "명령 URL을 입력해 주세요 (Socket Mode 앱은 비워 둘 수 있습니다)."
            : "명령을 추가하지 못했습니다.",
      );
    }
  };

  return (
    <details className="app-card">
      <summary>
        <strong>{app.name}</strong> <span className="muted">· 권한 {app.scopes.length}개 · 명령 {app.commands.length}개</span>
      </summary>
      <form onSubmit={save} className="stack">
        <label>
          이름
          <input name="name" defaultValue={app.name} required maxLength={80} />
        </label>
        <fieldset>
          <legend>권한 범위</legend>
          {appScopes.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" name={`scope:${s}`} defaultChecked={app.scopes.includes(s)} /> {SCOPE_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input type="checkbox" name="socketMode" defaultChecked={app.socketMode} /> Socket Mode (Slack 호환): 앱이 웹소켓으로 연결해 이벤트·명령·버튼을 받습니다. 공개 URL이
          필요 없고, 켜면 아래 URL들은 쓰지 않습니다.
        </label>
        <label>
          이벤트 URL
          <input name="eventsUrl" type="url" defaultValue={app.eventsUrl ?? ""} placeholder="https://example.com/chatter/events" />
        </label>
        <fieldset>
          <legend>받을 이벤트</legend>
          {appEventTypes.map((t) => (
            <label key={t} className="check">
              <input type="checkbox" name={`event:${t}`} defaultChecked={app.eventTypes.includes(t)} /> {EVENT_LABEL[t]}
            </label>
          ))}
        </fieldset>
        <label>
          버튼 클릭 URL
          <input name="interactivityUrl" type="url" defaultValue={app.interactivityUrl ?? ""} placeholder="https://example.com/chatter/actions" />
        </label>
        <label>
          서명 비밀값 (앱이 요청을 검증할 때 사용)
          <CopyField value={app.signingSecret} label={`${app.name} 서명 비밀값`} />
        </label>
        <div className="row wrap">
          <button type="submit">저장</button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (confirm("새 토큰을 발급할까요? 지금 토큰은 바로 쓸 수 없게 됩니다.")) void api.reissueAppToken(workspace.id, app.id).then(onIssued);
            }}
          >
            토큰 재발급
          </button>
          {app.socketMode && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (!app.hasAppToken || confirm("앱 토큰을 다시 발급할까요? 지금 연결은 끊기고 이전 토큰은 쓸 수 없게 됩니다.")) {
                  void api.issueSocketToken(workspace.id, app.id).then((a) => (onIssued(a), onChanged()));
                }
              }}
            >
              {app.hasAppToken ? "앱 토큰 재발급" : "앱 토큰 발급"}
            </button>
          )}
          <button
            type="button"
            className="link danger"
            onClick={() => {
              if (confirm(`${app.name} 앱을 삭제할까요? 토큰·명령·이벤트가 모두 멈춥니다.`)) void api.deleteApp(workspace.id, app.id).then(onChanged);
            }}
          >
            앱 삭제
          </button>
        </div>
        {message && <p className="muted">{message}</p>}
      </form>

      <details className="slack-ids">
        <summary>Slack 호환 정보 (Bolt 앱, Hermes 연결용)</summary>
        <dl>
          <dt>Slack API 주소</dt>
          <dd>
            <CopyField value={`${window.location.origin}/api/slack/`} label="Slack API 주소" />
          </dd>
          <dt>팀 ID</dt>
          <dd>
            <code>{slackId("T", workspace.id)}</code>
          </dd>
          <dt>봇 사용자 ID</dt>
          <dd>
            <code>{slackId("U", app.botUserId)}</code>
          </dd>
          <dt>내 사용자 ID</dt>
          <dd>
            <code>{slackId("U", me.id)}</code>
          </dd>
        </dl>
      </details>

      <h3>슬래시 커맨드</h3>
      <table className="admin-table">
        <tbody>
          {app.commands.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>/{c.command}</strong> {c.usageHint && <span className="muted">{c.usageHint}</span>}
              </td>
              <td className="muted">{c.description}</td>
              <td className="actions-cell">
                <button className="link danger" onClick={() => void api.deleteCommand(workspace.id, app.id, c.id).then(onChanged)}>
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={addCommand} className="row wrap">
        <input name="command" placeholder="/명령 (예: deploy)" aria-label="명령 이름" required />
        <input
          name="url"
          type="url"
          placeholder={app.socketMode ? "URL (Socket Mode면 비워 두세요)" : "https://example.com/chatter/commands"}
          aria-label="명령 URL"
          required={!app.socketMode}
        />
        <input name="description" placeholder="설명" aria-label="명령 설명" maxLength={100} />
        <input name="usageHint" placeholder="사용법 (예: [환경])" aria-label="명령 사용법" maxLength={100} />
        <button type="submit">명령 추가</button>
      </form>
    </details>
  );
}
