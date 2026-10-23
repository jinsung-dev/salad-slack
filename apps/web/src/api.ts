import type {
  Channel,
  CreateChannelInput,
  FileRef,
  Member,
  Message,
  MessagePage,
  NotifyLevel,
  PostMessageInput,
  Preferences,
  PresenceMap,
  Reaction,
  SearchQuery,
  User,
} from "@chatter/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

let onUnauthorized: () => void = () => {};

/** Called when a signed-in request is rejected because the session is gone. */
export function handleUnauthorized(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined || isForm ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Auth endpoints use 401 for "not signed in" / "wrong password", not an ended session.
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiError(res.status, (data as { error?: string }).error ?? "unknown");
  }
  return data as T;
}

const page = (before?: number) => (before ? `?before=${before}` : "");

export const api = {
  me: () => request<User>("GET", "/api/auth/me"),
  logout: () => request<void>("POST", "/api/auth/logout"),

  users: () => request<Member[]>("GET", "/api/users"),
  presence: () => request<PresenceMap>("GET", "/api/presence"),

  channels: () => request<Channel[]>("GET", "/api/channels"),
  createChannel: (input: CreateChannelInput) => request<Channel>("POST", "/api/channels", input),
  createDm: (userIds: string[]) => request<Channel>("POST", "/api/dms", { userIds }),
  joinChannel: (id: string) => request<void>("POST", `/api/channels/${id}/join`),
  invite: (id: string, userIds: string[]) => request<void>("POST", `/api/channels/${id}/members`, { userIds }),
  markRead: (id: string, messageId: number) => request<void>("POST", `/api/channels/${id}/read`, { messageId }),

  history: (channelId: string, before?: number) => request<MessagePage>("GET", `/api/channels/${channelId}/messages${page(before)}`),
  postMessage: (channelId: string, input: PostMessageInput) => request<Message>("POST", `/api/channels/${channelId}/messages`, input),

  message: (id: number) => request<Message>("GET", `/api/messages/${id}`),
  replies: (id: number, before?: number) => request<MessagePage>("GET", `/api/messages/${id}/replies${page(before)}`),
  markThreadRead: (id: number) => request<void>("POST", `/api/messages/${id}/thread/read`),
  editMessage: (id: number, text: string) => request<Message>("PATCH", `/api/messages/${id}`, { text }),
  deleteMessage: (id: number) => request<void>("DELETE", `/api/messages/${id}`),
  uploadFile: (channelId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<FileRef>("POST", `/api/channels/${channelId}/files`, form);
  },
  search: (query: SearchQuery) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request<MessagePage>("GET", `/api/search?${params}`);
  },
  setNotify: (channelId: string, level: NotifyLevel) => request<void>("PUT", `/api/channels/${channelId}/notify`, { level }),
  preferences: () => request<Preferences>("GET", "/api/me/preferences"),
  savePreferences: (prefs: Preferences) => request<void>("PUT", "/api/me/preferences", prefs),
  pushKey: () => request<{ publicKey: string }>("GET", "/api/push/key"),
  subscribePush: (sub: PushSubscriptionJSON) => request<void>("POST", "/api/push/subscriptions", sub),
  unsubscribePush: (endpoint: string) => request<void>("DELETE", "/api/push/subscriptions", { endpoint }),
  saved: () => request<MessagePage>("GET", "/api/saved"),
  setSaved: (id: number, saved: boolean) => request<void>(saved ? "PUT" : "DELETE", `/api/messages/${id}/save`),
  react: (id: number, emoji: string, add: boolean) =>
    request<Reaction[]>(add ? "PUT" : "DELETE", `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
};
