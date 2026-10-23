import type {
  Channel,
  CreateChannelInput,
  Member,
  Message,
  MessagePage,
  PostMessageInput,
  PresenceMap,
  Reaction,
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
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  react: (id: number, emoji: string, add: boolean) =>
    request<Reaction[]>(add ? "PUT" : "DELETE", `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
};
