import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { User, Workspace } from "@chatter/shared";
import { ApiError, api } from "../api";
import { keys } from "../cache";
import { workspacePath } from "../workspace";

/** Start a workspace or join one your email domain may enter. Invites arrive as links. */
export function Onboarding() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const mine = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  const joinable = useQuery({ queryKey: ["joinable"], queryFn: api.joinableWorkspaces, staleTime: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enter = async (workspaceId: string) => {
    await qc.invalidateQueries({ queryKey: keys.workspaces });
    navigate(workspacePath(workspaceId), { replace: true });
  };

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const domain = String(form.get("domain") ?? "").trim();
    if (!name) return setError("이름을 입력해 주세요.");
    setBusy(true);
    try {
      const created = await api.createWorkspace(name, domain || null);
      qc.setQueryData<Workspace[]>(keys.workspaces, (list) => [...(list ?? []), created]);
      navigate(workspacePath(created.id), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.code === "invalid_input" ? "도메인 형식을 확인해 주세요 (예: example.com)." : "만들지 못했습니다.");
      setBusy(false);
    }
  };

  if (qc.getQueryData<User | null>(keys.me)?.guestOnly) {
    // Outside guests only enter through invites; their access may also have ended.
    return (
      <div className="auth">
        <div className="auth-card onboarding">
          <h1>참여 중인 대화가 없습니다</h1>
          <p className="muted">게스트 계정은 초대받은 대화에만 참여할 수 있습니다. 초대한 사람에게 새 초대 링크를 요청해 주세요.</p>
          <button className="link" onClick={() => void api.logout().then(() => window.location.assign("/login"))}>
            로그아웃
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card onboarding">
        <h1>워크스페이스</h1>
        {(joinable.data?.length ?? 0) > 0 && (
          <section>
            <h2>참여할 수 있는 워크스페이스</h2>
            <ul className="joinable">
              {joinable.data!.map((w) => (
                <li key={w.id}>
                  <span>
                    <strong>{w.name}</strong> <span className="muted">· {w.memberCount}명</span>
                  </span>
                  <button onClick={() => void api.joinWorkspace(w.id).then(() => enter(w.id))}>참여</button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2>새 워크스페이스 만들기</h2>
          <form onSubmit={create} className="stack">
            <input name="name" placeholder="팀 이름 (예: SaladLab)" maxLength={80} autoFocus />
            <input name="domain" placeholder="회사 이메일 도메인 (선택, 예: example.com)" />
            <p className="muted hint">도메인을 적으면 그 도메인 이메일을 가진 사람은 초대 없이 참여할 수 있습니다.</p>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>
              만들기
            </button>
          </form>
        </section>

        <p className="muted hint">초대 링크를 받았다면 그 링크를 열면 됩니다.</p>
        {(mine.data?.length ?? 0) > 0 && (
          <Link to="/" className="link">
            ← 내 워크스페이스로 돌아가기
          </Link>
        )}
      </div>
    </div>
  );
}
