import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { GrantableRole, Invite, User, Webhook, WorkspaceRole } from "@chatter/shared";
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
                {canEdit(u.role) && u.id !== me.id ? (
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
