import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ClientEvent, Message, ServerEvent } from "@chatter/shared";
import {
  addMember,
  appendMessage,
  keys,
  removeMessage,
  replaceMessage,
  setPresence,
  updateChannel,
  updateMessage,
  upsertChannel,
} from "./cache";

export type ConnectionStatus = "connecting" | "open" | "closed";

interface Realtime {
  status: ConnectionStatus;
  send: (event: ClientEvent) => void;
}

const RealtimeContext = createContext<Realtime>({ status: "connecting", send: () => {} });
export const useConnectionStatus = () => useContext(RealtimeContext).status;
export const useSendEvent = () => useContext(RealtimeContext).send;

// What is on screen; messages there are marked read by the views instead of counted.
const active = { channelId: null as string | null, threadId: null as number | null };
export const setActiveChannel = (id: string | null) => void (active.channelId = id);
export const setActiveThread = (id: number | null) => void (active.threadId = id);
const visible = () => document.visibilityState === "visible";

// Who is typing where, expiring a few seconds after their last keystroke.
const TYPING_TTL_MS = 4_000;
const typing = new Map<string, Map<string, number>>();
const typingListeners = new Set<() => void>();
const typingKey = (channelId: string, parentId: number | null) => `${channelId}:${parentId ?? ""}`;
const notifyTyping = () => typingListeners.forEach((l) => l());

function noteTyping(channelId: string, parentId: number | null, userId: string) {
  const key = typingKey(channelId, parentId);
  const users = new Map(typing.get(key));
  users.set(userId, Date.now() + TYPING_TTL_MS);
  typing.set(key, users);
  notifyTyping();
  setTimeout(() => {
    const current = typing.get(key);
    if (!current || (current.get(userId) ?? 0) > Date.now()) return;
    const next = new Map(current);
    next.delete(userId);
    typing.set(key, next);
    notifyTyping();
  }, TYPING_TTL_MS + 50);
}

function clearTyping(channelId: string, parentId: number | null, userId: string) {
  const key = typingKey(channelId, parentId);
  const current = typing.get(key);
  if (!current?.has(userId)) return;
  const next = new Map(current);
  next.delete(userId);
  typing.set(key, next);
  notifyTyping();
}

const EMPTY = new Map<string, number>();
export function useTyping(channelId: string, parentId: number | null): string[] {
  const users = useSyncExternalStore(
    (l) => (typingListeners.add(l), () => typingListeners.delete(l)),
    () => typing.get(typingKey(channelId, parentId)) ?? EMPTY,
  );
  return [...users.keys()];
}

const MAX_BACKOFF_MS = 10_000;
const IDLE_MS = 5 * 60 * 1000;

export function RealtimeProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const awayRef = useRef(false);

  const send = (event: ClientEvent) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(event));
  };

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const countUnread = (message: Message) => {
      if (message.author.id === userId) return;
      const mentioned = message.mentionsChannel || message.mentions.includes(userId);
      const channelSeen = message.channelId === active.channelId && visible();
      const threadSeen = message.parentId !== null && message.parentId === active.threadId && visible();
      const channelLevel = message.parentId === null || message.alsoSentToChannel;
      updateChannel(qc, message.channelId, (c) => ({
        ...c,
        unreadCount: c.unreadCount + (channelLevel && !channelSeen ? 1 : 0),
        mentionCount: c.mentionCount + (mentioned && !(channelLevel ? channelSeen : threadSeen) ? 1 : 0),
      }));
    };

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "hello":
          return;
        case "channel.added":
          return upsertChannel(qc, event.channel, event.isMember);
        case "message.created":
          appendMessage(qc, event.message);
          countUnread(event.message);
          clearTyping(event.message.channelId, event.message.parentId, event.message.author.id);
          return;
        case "message.updated":
          return replaceMessage(qc, event.message);
        case "message.deleted":
          return removeMessage(qc, event.channelId, event.id);
        case "reaction.updated":
          return updateMessage(qc, event.channelId, event.messageId, (m) => ({ ...m, reactions: event.reactions }));
        case "member.joined":
          return addMember(qc, event.member);
        case "presence.changed":
          return setPresence(qc, event.userId, event.status);
        case "typing":
          return noteTyping(event.channelId, event.parentId, event.userId);
      }
    };

    const connect = () => {
      setStatus("connecting");
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/api/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        if (awayRef.current) socket.send(JSON.stringify({ type: "presence", status: "away" } satisfies ClientEvent));
        reportFocus();
        // Anything sent while we were disconnected is only in the database.
        if (attempt > 0) {
          for (const key of [keys.channels, keys.users, keys.presence, ["messages"], ["thread"], ["message"]]) {
            void qc.invalidateQueries({ queryKey: key });
          }
        }
        attempt = 0;
        setStatus("open");
      };
      socket.onmessage = (e) => handle(JSON.parse(String(e.data)) as ServerEvent);
      socket.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      };
    };

    // Away after a stretch with no input; back to active on the next one.
    let idleTimer: ReturnType<typeof setTimeout>;
    const setAway = (away: boolean) => {
      if (awayRef.current === away) return;
      awayRef.current = away;
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "presence", status: away ? "away" : "active" } satisfies ClientEvent));
      }
    };
    const onActivity = () => {
      setAway(false);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setAway(true), IDLE_MS);
    };
    const activity = ["pointermove", "keydown", "focus"] as const;
    activity.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    onActivity();

    // Whether someone is looking at this tab; the server skips push notifications for them.
    const reportFocus = () => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) return;
      const focused = document.visibilityState === "visible" && document.hasFocus();
      socketRef.current.send(JSON.stringify({ type: "focus", focused } satisfies ClientEvent));
    };
    const focusEvents = ["focus", "blur"] as const;
    focusEvents.forEach((e) => window.addEventListener(e, reportFocus));
    document.addEventListener("visibilitychange", reportFocus);

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(idleTimer);
      activity.forEach((e) => window.removeEventListener(e, onActivity));
      focusEvents.forEach((e) => window.removeEventListener(e, reportFocus));
      document.removeEventListener("visibilitychange", reportFocus);
      socketRef.current?.close();
    };
  }, [qc, userId]);

  return <RealtimeContext value={{ status, send }}>{children}</RealtimeContext>;
}
