import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import type { User } from "@chatter/shared";
import { api } from "../api";
import { keys } from "../cache";
import { ChannelView } from "../components/ChannelView";
import { SavedView, SearchView } from "../components/SearchView";
import { Sidebar } from "../components/Sidebar";
import { ThreadPanel } from "../components/ThreadPanel";
import { useCurrentWorkspace, workspacePath } from "../workspace";

export function Workspace({ me, view }: { me: User; view: "channel" | "search" | "saved" }) {
  const workspace = useCurrentWorkspace();
  const { channelId, threadId } = useParams();
  const channels = useQuery({ queryKey: keys.channels(workspace.id), queryFn: () => api.channels(workspace.id) });

  const list = channels.data ?? [];
  const current = view === "channel" ? list.find((c) => c.id === channelId) : undefined;
  const fallback = list.find((c) => c.isMember) ?? list[0];
  const parentId = threadId && /^\d+$/.test(threadId) ? Number(threadId) : undefined;

  if (view === "channel" && channels.isSuccess && !current && fallback) {
    return <Navigate to={workspacePath(workspace.id, `/c/${fallback.id}`)} replace />;
  }

  return (
    <div className={current && parentId !== undefined ? "workspace with-thread" : "workspace"}>
      <Sidebar me={me} channels={list} activeId={current?.id} />
      <main className="main">
        {view === "search" ? (
          <SearchView channels={list} me={me} />
        ) : view === "saved" ? (
          <SavedView channels={list} me={me} />
        ) : current ? (
          <ChannelView key={current.id} channel={current} me={me} />
        ) : (
          <div className="empty">
            {channels.isPending
              ? "불러오는 중…"
              : workspace.role === "guest"
                ? "아직 참여한 대화가 없습니다. 초대해 준 사람에게 채널 추가를 요청해 주세요."
                : "왼쪽에서 채널을 만들어 시작하세요."}
          </div>
        )}
      </main>
      {current && parentId !== undefined && <ThreadPanel key={parentId} channel={current} parentId={parentId} me={me} />}
    </div>
  );
}
