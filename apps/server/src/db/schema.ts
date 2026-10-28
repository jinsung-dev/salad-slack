import { sql } from "drizzle-orm";
import type { AppEventType, AppScope, Block } from "@chatter/shared";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  smallint,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Bots (webhooks) get a placeholder address under the reserved .invalid domain.
    email: text().notNull().unique(),
    displayName: text().notNull(),
    kind: text({ enum: ["person", "bot"] })
      .notNull()
      .default("person"),
    // The identity provider account (Google: issuer + `sub`); stable when the email changes.
    oidcIssuer: text(),
    oidcSubject: text(),
    // Outside guests who sign in with an emailed code instead of the provider; they only ever hold guest memberships.
    guestOnly: boolean().notNull().default(false),
    // Notification preferences. Quiet hours are minutes after local midnight in `timeZone`.
    timeZone: text().notNull().default("Asia/Seoul"),
    quietHoursEnabled: boolean().notNull().default(false),
    quietHoursStart: smallint().notNull().default(22 * 60),
    quietHoursEnd: smallint().notNull().default(8 * 60),
    createdAt: createdAt(),
  },
  (t) => [unique("users_oidc_identity_uq").on(t.oidcIssuer, t.oidcSubject)],
);

/** A team's space: its people, channels and messages, isolated from every other workspace. */
export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // People with a verified email at this domain may join without an invite; null = invite only.
  joinDomain: text(),
  createdBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const workspaceRoles = ["owner", "admin", "member", "guest"] as const;

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: workspaceRoles }).notNull().default("member"),
    // Guest accounts can end on a date; a sweep removes them like any removal.
    expiresAt: timestamp({ withTimezone: true }),
    joinedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_id_idx").on(t.userId),
    index("workspace_members_expires_at_idx").on(t.expiresAt),
  ],
);

/** Join links. Bound to one email they are single-use; otherwise reusable until they expire or are revoked. */
export const invites = pgTable(
  "invites",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Only the SHA-256 of the link token is stored.
    tokenHash: text().notNull().unique(),
    role: text({ enum: ["admin", "member", "guest"] }).notNull(),
    email: text(),
    // Accepting also adds the person to this channel (e.g. an outside guest for one project).
    channelId: uuid().references((): AnyPgColumn => channels.id, { onDelete: "cascade" }),
    // How long a guest who joins through this invite stays; null = no end.
    guestDays: smallint(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invites_workspace_id_idx").on(t.workspaceId)],
);

export const sessions = pgTable(
  "sessions",
  {
    // Only the SHA-256 of the cookie token is stored.
    tokenHash: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/** One-time sign-in codes mailed to outside guests. A new code replaces the address's earlier ones. */
export const emailCodes = pgTable(
  "email_codes",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    // SHA-256 of the row id and the code; the code itself is only in the mail.
    codeHash: text().notNull(),
    attempts: smallint().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("email_codes_email_idx").on(t.email, t.createdAt)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }),
    kind: text({ enum: ["public", "private", "dm"] })
      .notNull()
      .default("public"),
    // Unique within the workspace across public and private channels; null for DMs.
    name: text(),
    // Sorted member ids for DMs, so one set of people maps to one conversation per workspace.
    dmKey: text(),
    topic: text().notNull().default(""),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("channels_workspace_name_uq").on(t.workspaceId, t.name),
    unique("channels_workspace_dm_key_uq").on(t.workspaceId, t.dmKey),
    check(
      "channels_kind_shape",
      sql`(${t.kind} = 'dm' and ${t.name} is null and ${t.dmKey} is not null)
       or (${t.kind} <> 'dm' and ${t.name} is not null and ${t.dmKey} is null)`,
    ),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Everything at channel level with messages.id <= this is read.
    lastReadMessageId: bigint({ mode: "number" }).notNull().default(0),
    // Null follows the default for the conversation kind (DMs: all, channels: mentions).
    notify: text({ enum: ["all", "mentions", "none"] }),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] }), index("channel_members_user_id_idx").on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    // Threads are one level deep: a reply's parent is always top-level.
    parentId: bigint({ mode: "number" }).references((): AnyPgColumn => messages.id, { onDelete: "cascade" }),
    alsoSentToChannel: boolean().notNull().default(false),
    clientMsgId: text().notNull(),
    text: text().notNull(),
    mentionsChannel: boolean().notNull().default(false),
    // Structured layout from an app (validated `blocksSchema`); `text` is its fallback.
    blocks: jsonb().$type<Block[]>(),
    // Maintained on the parent when replies are added or deleted.
    replyCount: integer().notNull().default(0),
    lastReplyAt: timestamp({ withTimezone: true }),
    editedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_channel_id_id_idx").on(t.channelId, t.id),
    index("messages_parent_id_id_idx").on(t.parentId, t.id),
    // Substring search (ILIKE '%term%'); needs the pg_trgm extension (migration 0004).
    index("messages_text_trgm_idx").using("gin", sql`${t.text} gin_trgm_ops`),
    unique("messages_user_client_msg_id_uq").on(t.userId, t.clientMsgId),
  ],
);

export const reactions = pgTable(
  "reactions",
  {
    messageId: bigint({ mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/** One row per person a message mentions, `<!channel>` expanded to members at send time. */
export const mentions = pgTable(
  "mentions",
  {
    messageId: bigint({ mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    readAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] }), index("mentions_user_channel_idx").on(t.userId, t.channelId)],
);

/** Uploaded attachments. Bytes live in file storage under `storageKey`; a file joins a message when it is posted. */
export const files = pgTable(
  "files",
  {
    id: uuid().primaryKey().defaultRandom(),
    uploaderId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The conversation it was uploaded for; it can only be attached there.
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: bigint({ mode: "number" }).references(() => messages.id, { onDelete: "cascade" }),
    name: text().notNull(),
    mimeType: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    storageKey: text().notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index("files_message_id_idx").on(t.messageId)],
);

/** Browser push endpoints (Web Push), one per browser profile a person enabled notifications in. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    endpoint: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    p256dh: text().notNull(),
    auth: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user_id_idx").on(t.userId)],
);

/** Messages a person bookmarked for later. */
export const savedMessages = pgTable(
  "saved_messages",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: bigint({ mode: "number" })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    savedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.messageId] })],
);

/** Incoming webhooks: a secret URL that posts into one channel as its own bot user. */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    botUserId: uuid()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    tokenHash: text().notNull().unique(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_workspace_id_idx").on(t.workspaceId)],
);

/** An app installed in one workspace: its bot user, token, events and interactivity endpoints. */
export const apps = pgTable(
  "apps",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
    botUserId: uuid()
      .notNull()
      .references(() => users.id),
    // Only the SHA-256 of the bot token is stored.
    tokenHash: text().notNull().unique(),
    scopes: text().array().$type<AppScope[]>().notNull().default(sql`'{}'::text[]`),
    // Shared with the app to sign requests Chatter sends it.
    signingSecret: text().notNull(),
    eventsUrl: text(),
    eventTypes: text().array().$type<AppEventType[]>().notNull().default(sql`'{}'::text[]`),
    interactivityUrl: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("apps_workspace_id_idx").on(t.workspaceId), unique("apps_bot_user_uq").on(t.botUserId)],
);

export const slashCommands = pgTable(
  "slash_commands",
  {
    id: uuid().primaryKey().defaultRandom(),
    appId: uuid()
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Without the slash; one app owns a name within a workspace.
    command: text().notNull(),
    url: text().notNull(),
    description: text().notNull().default(""),
    usageHint: text().notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [unique("slash_commands_workspace_command_uq").on(t.workspaceId, t.command)],
);

/** Response URLs handed to apps with a command or click: a few late replies into one conversation, for one person. */
export const responseUrls = pgTable("response_urls", {
  tokenHash: text().primaryKey(),
  appId: uuid()
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  channelId: uuid()
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  parentId: bigint({ mode: "number" }),
  // Who ran the command or clicked; ephemeral replies go to them.
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Set for clicks: the message a reply may replace.
  messageId: bigint({ mode: "number" }).references(() => messages.id, { onDelete: "cascade" }),
  usesLeft: smallint().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
