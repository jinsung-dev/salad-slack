import { useEffect } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { Channel, User } from "@chatter/shared";
import { ApiError, api } from "../api";
import { flattenPages, keys } from "../cache";
import { channelLabel, useDirectory } from "../directory";
import { setActiveThread } from "../realtime";
import { workspacePath } from "../workspace";
import { Composer } from "./Composer";
import { EphemeralList } from "./EphemeralList";
import { MessageList } from "./MessageList";
import { MessageRow } from "./MessageRow";

export function ThreadPanel({ channel, parentId, me }: { channel: Channel; parentId: number; me: User }) {
  const qc = useQueryClient();
  const { names } = useDirectory();
  const parent = useQuery({ queryKey: keys.message(parentId), queryFn: () => api.message(parentId) });
  const replies = useInfiniteQuery({
    queryKey: keys.thread(parentId),
    queryFn: ({ pageParam }) => api.replies(parentId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
  });
  const messages = flattenPages(replies.data);
  const newestId = messages.at(-1)?.id;

  useEffect(() => {
    setActiveThread(parentId);
    return () => setActiveThread(null);
  }, [parentId]);

  useEffect(() => {
    if (!channel.isMember || !parent.data) return;
    const mark = async () => {
      if (document.visibilityState !== "visible") return;
      await api.markThreadRead(parentId);
      void qc.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
    };
    void mark();
  }, [channel.isMember, parentId, newestId, parent.data, qc]);

  const close = workspacePath(channel.workspaceId, `/c/${channel.id}`);
  const gone = parent.error instanceof ApiError && parent.error.status === 404;

  return (
    <aside className="thread" aria-label="스레드">
      <header className="thread-header">
        <div>
          <h2>스레드</h2>
          <p className="muted">{channel.kind === "dm" ? channelLabel(channel, names, me.id) : `#${channelLabel(channel, names, me.id)}`}</p>
        </div>
        <Link to={close} className="close" aria-label="스레드 닫기">
          ✕
        </Link>
      </header>

      {gone ? (
        <div className="empty">이 스레드는 삭제되었습니다.</div>
      ) : (
        <>
          <MessageList
            messages={messages}
            me={me.id}
            hasMore={replies.hasNextPage}
            loadingMore={replies.isFetchingNextPage}
            loadMore={() => void replies.fetchNextPage()}
            start={
              parent.data && (
                <div className="thread-parent">
                  <MessageRow message={parent.data} previous={undefined} me={me.id} canInteract={channel.isMember} />
                  <div className="reply-divider muted">
                    {parent.data.thread ? `답글 ${parent.data.thread.replyCount}개` : "아직 답글이 없습니다"}
                  </div>
                </div>
              )
            }
          >
            {messages.map((m, i) => (
              <MessageRow key={m.id} message={m} previous={messages[i - 1]} me={me.id} canInteract={channel.isMember} />
            ))}
            <EphemeralList channelId={channel.id} parentId={parentId} me={me.id} />
          </MessageList>
          {channel.isMember && parent.data && !parent.data.deleted && (
            <Composer channelId={channel.id} parentId={parentId} placeholder="답글 보내기" />
          )}
        </>
      )}
    </aside>
  );
}
