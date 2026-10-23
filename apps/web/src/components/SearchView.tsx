import { Fragment, useMemo, type ReactNode } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { CHANNEL_MENTION, type Channel, type Message, type SearchQuery, type User } from "@chatter/shared";
import { api } from "../api";
import { keys } from "../cache";
import { channelLabel, nameOf, useDirectory, type Names } from "../directory";
import { Avatar } from "./People";

const PERIODS = { all: "전체 기간", "1": "오늘", "7": "최근 7일", "30": "최근 30일" } as const;
type Period = keyof typeof PERIODS;

const timeFormat = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Mentions shown by name; formatting marks are left as typed since results show plain text. */
function plainText(text: string, names: Names) {
  return text.replaceAll(CHANNEL_MENTION, "@channel").replace(/<@([0-9a-f-]{36})>/g, (_, id: string) => `@${nameOf(names, id)}`);
}

function highlight(text: string, words: string[]): ReactNode {
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

export function SearchView({ channels, me }: { channels: Channel[]; me: User }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { users, names } = useDirectory();
  const q = params.get("q")?.trim() ?? "";
  const channelId = params.get("channel") ?? "";
  const authorId = params.get("author") ?? "";
  const period = (params.get("period") ?? "all") as Period;

  const query = useMemo((): SearchQuery | null => {
    if (!q) return null;
    const from = period === "all" ? undefined : new Date(new Date().setHours(0, 0, 0, 0) - (Number(period) - 1) * 86_400_000).toISOString();
    return { q, channelId: channelId || undefined, authorId: authorId || undefined, from };
  }, [q, channelId, authorId, period]);

  const results = useInfiniteQuery({
    queryKey: ["search", query],
    queryFn: ({ pageParam }) => api.search({ ...query!, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages.at(-1)?.id : undefined),
    enabled: query !== null,
    staleTime: 0,
  });
  const found = results.data?.pages.flatMap((p) => p.messages) ?? [];
  const words = q.split(/\s+/).filter(Boolean);
  const byId = new Map(channels.map((c) => [c.id, c]));

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  // A result opens beside its conversation: the message, or the thread it belongs to.
  const open = (m: Message) => navigate(`/c/${m.channelId}/t/${m.parentId ?? m.id}`);

  return (
    <section className="channel search-view">
      <header className="channel-header">
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", String(new FormData(e.currentTarget).get("q") ?? "").trim());
          }}
        >
          <input key={q} name="q" type="search" defaultValue={q} placeholder="메시지 검색" aria-label="검색어" autoFocus />
          <select value={channelId} onChange={(e) => set("channel", e.target.value)} aria-label="대화">
            <option value="">모든 대화</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === "dm" ? "" : "#"}
                {channelLabel(c, names, me.id)}
              </option>
            ))}
          </select>
          <select value={authorId} onChange={(e) => set("author", e.target.value)} aria-label="보낸 사람">
            <option value="">모든 사람</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
          <select value={period} onChange={(e) => set("period", e.target.value === "all" ? "" : e.target.value)} aria-label="기간">
            {(Object.keys(PERIODS) as Period[]).map((p) => (
              <option key={p} value={p}>
                {PERIODS[p]}
              </option>
            ))}
          </select>
        </form>
      </header>

      <div className="messages search-results">
        {!q && <p className="empty-note muted">검색어를 입력하세요. 띄어쓴 단어가 모두 들어간 메시지를 찾습니다.</p>}
        {q && results.isPending && <p className="empty-note muted">찾는 중…</p>}
        {q && results.isSuccess && found.length === 0 && <p className="empty-note muted">“{q}”에 맞는 메시지가 없습니다.</p>}
        {found.map((m) => (
          <MessageResult key={m.id} message={m} channel={byId.get(m.channelId)} me={me} words={words} onOpen={open} />
        ))}
        {results.hasNextPage && (
          <button className="secondary more" onClick={() => void results.fetchNextPage()} disabled={results.isFetchingNextPage}>
            더 보기
          </button>
        )}
      </div>
    </section>
  );
}

/** One message in a list (search results, saved messages); opens it beside its conversation. */
export function MessageResult({
  message: m,
  channel,
  me,
  words = [],
  onOpen,
}: {
  message: Message;
  channel: Channel | undefined;
  me: User;
  words?: string[];
  onOpen: (m: Message) => void;
}) {
  const { names } = useDirectory();
  return (
    <button className="search-result" onClick={() => onOpen(m)}>
      <span className="result-where muted">
        {channel ? `${channel.kind === "dm" ? "" : "#"}${channelLabel(channel, names, me.id)}` : "대화"}
        {m.parentId !== null && " · 스레드"} · {timeFormat.format(new Date(m.createdAt))}
      </span>
      <span className="result-body">
        <Avatar name={m.author.displayName} size="sm" />
        <span>
          <strong>{m.author.displayName}</strong> {highlight(plainText(m.text, names), words)}
          {m.files.length > 0 && <span className="muted"> · 파일 {m.files.length}개</span>}
        </span>
      </span>
    </button>
  );
}

export function SavedView({ channels, me }: { channels: Channel[]; me: User }) {
  const navigate = useNavigate();
  const saved = useQuery({ queryKey: keys.saved, queryFn: api.saved, staleTime: 0 });
  const byId = new Map(channels.map((c) => [c.id, c]));
  return (
    <section className="channel search-view">
      <header className="channel-header">
        <h1>🔖 저장한 메시지</h1>
      </header>
      <div className="messages search-results">
        {saved.isPending && <p className="empty-note muted">불러오는 중…</p>}
        {saved.isSuccess && saved.data.messages.length === 0 && (
          <p className="empty-note muted">메시지에 마우스를 올리고 🔖를 누르면 여기에 모입니다.</p>
        )}
        {saved.data?.messages.map((m) => (
          <MessageResult key={m.id} message={m} channel={byId.get(m.channelId)} me={me} onOpen={(x) => navigate(`/c/${x.channelId}/t/${x.parentId ?? x.id}`)} />
        ))}
      </div>
    </section>
  );
}
