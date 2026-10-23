import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api";
import { keys } from "../cache";
import { workspacePath } from "../workspace";

const ROLE_LABEL = { admin: "관리자", member: "멤버", guest: "게스트" } as const;

export function InvitePage() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const preview = useQuery({ queryKey: ["invite", token], queryFn: () => api.previewInvite(token), retry: false });
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    try {
      const { workspaceId, channelId } = await api.acceptInvite(token);
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      navigate(workspacePath(workspaceId, channelId ? `/c/${channelId}` : ""), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.code === "invite_for_other_email" ? "이 초대는 다른 이메일 주소로 보낸 것입니다." : "초대를 받을 수 없습니다.");
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        {preview.isPending && <p className="muted">초대를 확인하는 중…</p>}
        {preview.isError && (
          <>
            <h1>초대가 유효하지 않습니다</h1>
            <p className="muted">만료되었거나 취소된 초대입니다. 보낸 사람에게 새 링크를 요청해 주세요.</p>
            <Link to="/">홈으로</Link>
          </>
        )}
        {preview.data && (
          <>
            <h1>{preview.data.workspace.name}</h1>
            <p>
              <strong>{preview.data.inviter}</strong> 님이{" "}
              {preview.data.channel ? (
                <>
                  <strong>#{preview.data.channel.name}</strong> 채널에{" "}
                </>
              ) : null}
              {ROLE_LABEL[preview.data.role]}(으)로 초대했습니다.
            </p>
            {preview.data.role === "guest" && (
              <p className="muted hint">
                게스트는 초대받은 대화만 볼 수 있습니다.
                {preview.data.guestDays ? ` ${preview.data.guestDays}일 뒤 자동으로 나가게 됩니다.` : ""}
              </p>
            )}
            {preview.data.email && <p className="muted hint">{preview.data.email} 계정 전용 초대입니다.</p>}
            {error && <p className="error">{error}</p>}
            {preview.data.alreadyMember ? (
              // Already in the workspace: a channel invite still adds them to its channel.
              preview.data.channel ? (
                <button onClick={() => void accept()}>채널 열기</button>
              ) : (
                <button onClick={() => navigate(workspacePath(preview.data.workspace.id))}>워크스페이스 열기</button>
              )
            ) : (
              <button onClick={() => void accept()}>참여하기</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
