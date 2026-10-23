import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Message } from "@chatter/shared";

const NEAR_BOTTOM_PX = 120;

/**
 * A scrolling message list that loads older pages at the top, keeps its
 * position while they load, and follows new messages when the reader is at
 * the bottom (or wrote the message).
 */
export function MessageList({
  messages,
  me,
  hasMore,
  loadingMore,
  loadMore,
  start,
  children,
}: {
  messages: Message[];
  me: string;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** Shown above the oldest message once everything is loaded. */
  start: ReactNode;
  children: ReactNode;
}) {
  const newestId = messages.at(-1)?.id;
  const oldestId = messages[0]?.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  const prev = useRef({ oldestId: undefined as number | undefined, newestId: undefined as number | undefined, height: 0 });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const p = prev.current;
    if (p.newestId === undefined) {
      el.scrollTop = el.scrollHeight;
    } else if (oldestId !== p.oldestId && newestId === p.newestId) {
      el.scrollTop += el.scrollHeight - p.height;
    } else if (newestId !== p.newestId) {
      const nearBottom = p.height - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (nearBottom || messages.at(-1)?.author.id === me) el.scrollTop = el.scrollHeight;
    }
    prev.current = { oldestId, newestId, height: el.scrollHeight };
  });

  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !loadingMore) loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, loadMore]);

  return (
    <div className="messages" ref={scrollRef}>
      <div ref={topRef} className="history-edge">
        {loadingMore ? "이전 메시지 불러오는 중…" : !hasMore && start}
      </div>
      {children}
    </div>
  );
}
