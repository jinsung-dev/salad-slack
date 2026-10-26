import type {
  App,
  Channel,
  CommandInfo,
  CreateChannelInput,
  FileRef,
  GrantableRole,
  Invite,
  InvitePreview,
  JoinableWorkspace,
  Member,
  Message,
  MessagePage,
  NotifyLevel,
  PostMessageInput,
  Preferences,
  PresenceMap,
  Reaction,
  SearchQuery,
  UpdateAppInput,
  User,
  Webhook,
  Workspace,
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
const ws = (workspaceId: string, rest = "") => `/api/workspaces/${workspaceId}${rest}`;

export const api = {
  me: () => request<User>("GET", "/api/auth/me"),
  logout: () => request<void>("POST", "/api/auth/logout"),

  workspaces: () => request<Workspace[]>("GET", "/api/workspaces"),
  createWorkspace: (name: string, joinDomain: string | null) => request<Workspace>("POST", "/api/workspaces", { name, joinDomain }),
  updateWorkspace: (wid: string, name: string, joinDomain: string | null) => request<void>("PUT", ws(wid), { name, joinDomain }),
  joinableWorkspaces: () => request<JoinableWorkspace[]>("GET", "/api/workspaces/joinable"),
  joinWorkspace: (wid: string) => request<void>("POST", ws(wid, "/join")),
  setRole: (wid: string, userId: string, role: GrantableRole) => request<void>("PUT", ws(wid, `/members/${userId}/role`), { role }),
  removeMember: (wid: string, userId: string) => request<void>("DELETE", ws(wid, `/members/${userId}`)),

  invites: (wid: string) => request<Invite[]>("GET", ws(wid, "/invites")),
  createInvite: (wid: string, invite: { role: GrantableRole; email?: string | null; channelId?: string | null; guestDays?: number | null }) =>
    request<Invite>("POST", ws(wid, "/invites"), invite),
  revokeInvite: (wid: string, id: string) => request<void>("DELETE", ws(wid, `/invites/${id}`)),
  previewInvite: (token: string) => request<InvitePreview>("GET", `/api/invites/${token}`),
  acceptInvite: (token: string) => request<{ workspaceId: string; channelId: string | null }>("POST", `/api/invites/${token}/accept`),

  webhooks: (wid: string) => request<Webhook[]>("GET", ws(wid, "/webhooks")),
  createWebhook: (wid: string, channelId: string, name: string) => request<Webhook>("POST", ws(wid, "/webhooks"), { channelId, name }),
  revokeWebhook: (wid: string, id: string) => request<void>("DELETE", ws(wid, `/webhooks/${id}`)),

  apps: (wid: string) => request<App[]>("GET", ws(wid, "/apps")),
  createApp: (wid: string, name: string) => request<App>("POST", ws(wid, "/apps"), { name }),
  updateApp: (wid: string, appId: string, input: UpdateAppInput) => request<App>("PUT", ws(wid, `/apps/${appId}`), input),
  reissueAppToken: (wid: string, appId: string) => request<App>("POST", ws(wid, `/apps/${appId}/token`)),
  deleteApp: (wid: string, appId: string) => request<void>("DELETE", ws(wid, `/apps/${appId}`)),
  addCommand: (wid: string, appId: string, input: { command: string; url: string; description: string; usageHint: string }) =>
    request<void>("POST", ws(wid, `/apps/${appId}/commands`), input),
  deleteCommand: (wid: string, appId: string, commandId: string) => request<void>("DELETE", ws(wid, `/apps/${appId}/commands/${commandId}`)),
  commands: (wid: string) => request<CommandInfo[]>("GET", ws(wid, "/commands")),
  runCommand: (channelId: string, command: string, text: string, parentId: number | null) =>
    request<void>("POST", `/api/channels/${channelId}/commands`, { command, text, parentId }),
  clickAction: (messageId: number, actionId: string, value?: string) => request<void>("POST", `/api/messages/${messageId}/actions`, { actionId, value }),

  members: (wid: string) => request<Member[]>("GET", ws(wid, "/members")),
  presence: (wid: string) => request<PresenceMap>("GET", ws(wid, "/presence")),

  channels: (wid: string) => request<Channel[]>("GET", ws(wid, "/channels")),
  channel: (id: string) => request<Channel>("GET", `/api/channels/${id}`),
  createChannel: (wid: string, input: CreateChannelInput) => request<Channel>("POST", ws(wid, "/channels"), input),
  createDm: (wid: string, userIds: string[]) => request<Channel>("POST", ws(wid, "/dms"), { userIds }),
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
  saved: (wid: string) => request<MessagePage>("GET", ws(wid, "/saved")),
  setSaved: (id: number, saved: boolean) => request<void>(saved ? "PUT" : "DELETE", `/api/messages/${id}/save`),
  react: (id: number, emoji: string, add: boolean) =>
    request<Reaction[]>(add ? "PUT" : "DELETE", `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
};
