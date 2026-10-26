import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import type { Channel, User } from "@chatter/shared";
import { api } from "../api";
import { flattenPages, keys, updateChannel } from "../cache";
import { channelLabel, useDirectory } from "../directory";
import { setActiveChannel } from "../realtime";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { MessageRow } from "./MessageRow";
import { PresenceDot, UserPicker } from "./People";
import { ChannelInviteDialog } from "./ChannelInvite";
import { NotifySelect } from "./Settings";
import { useCurrentWorkspace, workspacePath } from "../workspace";

export function ChannelView({ channel, me }: { channel: Channel; me: User }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { names } = useDirectory();
  const [inviting, setInviting] = useState(false);
  const [invitingOutsider, setInvitingOutsider] = useState(false);
  const workspace = useCurrentWorkspace();
  const history = useInfiniteQuery({
    queryKey: keys.messages(channel.id),
    queryFn: ({ pageParam }) => api.history(channel.id, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
  });
  const messages = flattenPages(history.data);
  const newestId = messages.at(-1)?.id;
  const label = channelLabel(channel, names, me.id);
  const dmPeer = channel.kind === "dm" && channel.memberIds?.length === 2 ? channel.memberIds.find((id) => id !== me.id) : undefined;

  useEffect(() => {
    setActiveChannel(channel.id);
    return () => setActiveChannel(null);
  }, [channel.id]);

  // Mark read whenever the newest visible message changes or the tab regains focus.
  const markedRef = useRef(0);
  useEffect(() => {
    if (!channel.isMember || newestId === undefined) return;
    const mark = async () => {
      if (document.visibilityState !== "visible") return;
      updateChannel(qc, channel.id, (c) => ({ ...c, unreadCount: 0 }));
      if (newestId <= markedRef.current) return;
      markedRef.current = newestId;
      await api.markRead(channel.id, newestId);
      // Thread mentions survive a channel read; the server has the exact count.
      void qc.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
    };
    void mark();
    const onVisible = () => void mark();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [channel.id, channel.isMember, newestId, qc]);

  const join = async () => {
    await api.joinChannel(channel.id);
    updateChannel(qc, channel.id, (c) => ({ ...c, isMember: true, unreadCount: 0 }));
  };

  const openThread = (id: number) => navigate(workspacePath(channel.workspaceId, `/c/${channel.id}/t/${id}`));

  return (
    <section className="channel">
      <header className="channel-header">
        <div className="title-row">
          <h1>
            {channel.kind === "dm" ? (
              <>
                {dmPeer && <PresenceDot userId={dmPeer} />} {label}
              </>
            ) : (
              <>
                {channel.kind === "private" ? "🔒" : "#"} {label}
              </>
            )}
          </h1>
          <div className="header-actions">
            {channel.isMember && <NotifySelect channelId={channel.id} level={channel.notify} />}
            {channel.kind !== "dm" && channel.isMember && workspace.role !== "guest" && (
              <button className="secondary" onClick={() => setInviting(true)}>
                사람 추가
              </button>
            )}
            {channel.kind !== "dm" && channel.isMember && (workspace.role === "owner" || workspace.role === "admin") && (
              <button className="secondary" onClick={() => setInvitingOutsider(true)}>
                외부인 초대
              </button>
            )}
          </div>
        </div>
        {channel.topic && <p className="muted">{channel.topic}</p>}
      </header>

      <MessageList
        messages={messages}
        me={me.id}
        hasMore={history.hasNextPage}
        loadingMore={history.isFetchingNextPage}
        loadMore={() => void history.fetchNextPage()}
        start={
          history.isPending ? (
            "불러오는 중…"
          ) : (
            <div className="channel-intro">
              <h2>{channel.kind === "dm" ? label : `${channel.kind === "private" ? "🔒" : "#"} ${label}`}</h2>
              <p className="muted">{channel.kind === "dm" ? "대화의 시작입니다." : "채널의 시작입니다."}</p>
            </div>
          )
        }
      >
        {messages.map((m, i) => (
          <MessageRow key={m.id} message={m} previous={messages[i - 1]} me={me.id} canInteract={channel.isMember} onOpenThread={openThread} />
        ))}
      </MessageList>

      {channel.isMember ? (
        <Composer channelId={channel.id} placeholder={channel.kind === "dm" ? `${label}에게 메시지 보내기` : `#${label}에 메시지 보내기`} />
      ) : (
        <div className="join-banner">
          <span>
            <strong>#{label}</strong> 채널을 미리 보고 있습니다.
          </span>
          <button onClick={join}>채널 참여</button>
        </div>
      )}

      {invitingOutsider && <ChannelInviteDialog channel={channel} onClose={() => setInvitingOutsider(false)} />}
      {inviting && (
        <UserPicker
          title={`#${label}에 사람 추가`}
          confirmLabel="추가"
          exclude={[me.id]}
          max={50}
          onConfirm={(ids) => api.invite(channel.id, ids)}
          onClose={() => setInviting(false)}
        />
      )}
    </section>
  );
}
