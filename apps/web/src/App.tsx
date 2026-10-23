import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router";
import { ApiError, api } from "./api";
import { keys } from "./cache";
import { AuthPage } from "./pages/AuthPage";
import { Workspace } from "./pages/Workspace";
import { RealtimeProvider } from "./realtime";

export function App() {
  const me = useQuery({
    queryKey: keys.me,
    queryFn: () => api.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
  });

  if (me.isPending) return <div className="splash">불러오는 중…</div>;
  if (me.isError) return <div className="splash">서버에 연결할 수 없습니다.</div>;

  if (!me.data) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <RealtimeProvider userId={me.data.id}>
      <Routes>
        {/* One route, so opening a thread keeps the channel view mounted. */}
        <Route path="/c/:channelId/t?/:threadId?" element={<Workspace me={me.data} />} />
        <Route path="*" element={<Workspace me={me.data} />} />
      </Routes>
    </RealtimeProvider>
  );
}
