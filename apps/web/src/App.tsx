import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import type { User } from "@chatter/shared";
import { ApiError, api } from "./api";
import { keys } from "./cache";
import { registerServiceWorker } from "./notifications";
import { AuthPage } from "./pages/AuthPage";
import { InvitePage } from "./pages/InvitePage";
import { Onboarding } from "./pages/Onboarding";
import { WorkspaceAdmin } from "./pages/WorkspaceAdmin";
import { Workspace } from "./pages/Workspace";
import { RealtimeProvider } from "./realtime";
import { WorkspaceProvider, lastWorkspace, rememberWorkspace, workspacePath } from "./workspace";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: () => api.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
  });

  const signedIn = Boolean(me.data);
  // Notification clicks arrive from the service worker as in-app navigations.
  useEffect(() => {
    if (signedIn) void registerServiceWorker((path) => navigate(path));
  }, [signedIn, navigate]);

  if (me.isPending) return <div className="splash">불러오는 중…</div>;
  if (me.isError) return <div className="splash">서버에 연결할 수 없습니다.</div>;

  if (!me.data) {
    // Come back to the same page (e.g. an invite link) after signing in.
    const here = location.pathname === "/login" ? "" : `${location.pathname}${location.search}`;
    return (
      <Routes>
        <Route path="/login" element={<AuthPage />} />
        <Route path="*" element={<Navigate to={here && here !== "/" ? `/login?returnTo=${encodeURIComponent(here)}` : "/login"} replace />} />
      </Routes>
    );
  }

  return (
    <RealtimeProvider userId={me.data.id}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/new" element={<Onboarding />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/w/:workspaceId/*" element={<WorkspaceRoot me={me.data} />} />
        {/* Links from before workspaces carried only the channel. */}
        <Route path="/c/:channelId/*" element={<LegacyChannelLink />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RealtimeProvider>
  );
}

/** The last workspace used here, else the first; a person in none starts on onboarding. */
function Home() {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  if (workspaces.isPending) return <div className="splash">불러오는 중…</div>;
  const list = workspaces.data ?? [];
  if (list.length === 0) return <Navigate to="/new" replace />;
  const remembered = list.find((w) => w.id === lastWorkspace());
  return <Navigate to={workspacePath((remembered ?? list[0]!).id)} replace />;
}

function WorkspaceRoot({ me }: { me: User }) {
  const { workspaceId } = useParams();
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces });
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  useEffect(() => {
    if (workspace) rememberWorkspace(workspace.id);
  }, [workspace]);

  if (workspaces.isPending) return <div className="splash">불러오는 중…</div>;
  if (!workspace) return <Navigate to="/" replace />;
  return (
    <WorkspaceProvider workspace={workspace}>
      <Routes>
        {/* One route per view, so opening a thread keeps the channel view mounted. */}
        <Route path="c/:channelId/t?/:threadId?" element={<Workspace me={me} view="channel" />} />
        <Route path="search" element={<Workspace me={me} view="search" />} />
        <Route path="saved" element={<Workspace me={me} view="saved" />} />
        <Route path="admin" element={<WorkspaceAdmin me={me} />} />
        <Route path="*" element={<Workspace me={me} view="channel" />} />
      </Routes>
    </WorkspaceProvider>
  );
}

function LegacyChannelLink() {
  const { channelId, "*": rest } = useParams();
  const channel = useQuery({ queryKey: ["channel-lookup", channelId], queryFn: () => api.channel(channelId!), retry: false });
  if (channel.isPending) return <div className="splash">불러오는 중…</div>;
  if (!channel.data) return <Navigate to="/" replace />;
  return <Navigate to={workspacePath(channel.data.workspaceId, `/c/${channelId}${rest ? `/${rest}` : ""}`)} replace />;
}
