import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useParams } from "react-router";
import type { User } from "@chatter/shared";
import { api } from "../api";
import { keys } from "../cache";
import { ChannelView } from "../components/ChannelView";
import { SavedView, SearchView } from "../components/SearchView";
import { Sidebar } from "../components/Sidebar";
import { ThreadPanel } from "../components/ThreadPanel";

export function Workspace({ me }: { me: User }) {
  const { channelId, threadId } = useParams();
  const { pathname } = useLocation();
  const searching = pathname === "/search";
  const showingSaved = pathname === "/saved";
  const channels = useQuery({ queryKey: keys.channels, queryFn: api.channels });

  const list = channels.data ?? [];
  const current = list.find((c) => c.id === channelId);
  const fallback = list.find((c) => c.isMember) ?? list[0];
  const parentId = threadId && /^\d+$/.test(threadId) ? Number(threadId) : undefined;

  if (!searching && !showingSaved && channels.isSuccess && !current && fallback) return <Navigate to={`/c/${fallback.id}`} replace />;

  return (
    <div className={parentId ? "workspace with-thread" : "workspace"}>
      <Sidebar me={me} channels={list} activeId={current?.id} />
      <main className="main">
        {searching ? (
          <SearchView channels={list} me={me} />
        ) : showingSaved ? (
          <SavedView channels={list} me={me} />
        ) : current ? (
          <ChannelView key={current.id} channel={current} me={me} />
        ) : (
          <div className="empty">{channels.isPending ? "불러오는 중…" : "왼쪽에서 채널을 만들어 시작하세요."}</div>
        )}
      </main>
      {current && parentId !== undefined && <ThreadPanel key={parentId} channel={current} parentId={parentId} me={me} />}
    </div>
  );
}
