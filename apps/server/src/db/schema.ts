import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
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
    email: text().notNull().unique(),
    displayName: text().notNull(),
    // The identity provider account (Google: issuer + `sub`); stable when the email changes.
    oidcIssuer: text(),
    oidcSubject: text(),
    createdAt: createdAt(),
  },
  (t) => [unique("users_oidc_identity_uq").on(t.oidcIssuer, t.oidcSubject)],
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

export const channels = pgTable(
  "channels",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text({ enum: ["public", "private", "dm"] })
      .notNull()
      .default("public"),
    // Unique across public and private channels; null for DMs.
    name: text().unique(),
    // Sorted member ids for DMs, so one set of people maps to one conversation.
    dmKey: text().unique(),
    topic: text().notNull().default(""),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
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
