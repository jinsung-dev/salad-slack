import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { parseMentions, type Block, type Message, type postMessageInput, type Reaction } from "@chatter/shared";
import type { z } from "zod";
import type { AppDeps } from "./app";
import { channelMembers, files, mentions, messages, reactions } from "./db/schema";
import { dispatchMessageEvents } from "./events";
import { notifyNewMessage } from "./notify";
import { loadMessage, memberIds } from "./queries";

// Single path for creating, editing, deleting and reacting to messages, used by
// people (REST), webhooks and apps: mentions, attachments, thread bookkeeping,
// realtime delivery and push. Callers check that the actor may do it first.

/** People send text and files; apps may add blocks. */
export type SendInput = z.output<typeof postMessageInput> & { blocks?: Block[] };

export type SendResult =
  | { kind: "created"; message: Message }
  /** A retry of an accepted send (same clientMsgId): the original, not re-broadcast. */
  | { kind: "existing"; message: Message }
  | { kind: "rejected"; error: "invalid_input" | "invalid_parent" | "invalid_files" | "client_msg_id_reused" };

/** Who a text notifies: explicit mentions of members, or every member for `<!channel>`; never the author. */
export function mentionTargets(text: string, members: string[], author: string) {
  const parsed = parseMentions(text);
  const memberSet = new Set(members);
  const targets = new Set(parsed.channel ? members : parsed.userIds.filter((u) => memberSet.has(u)));
  targets.delete(author);
  return { targets: [...targets], channel: parsed.channel };
}

/** Thrown inside the send transaction to roll it back when an attachment is not the sender's to attach. */
class InvalidFiles extends Error {}

export type MessageRow = typeof messages.$inferSelect;

export async function sendMessage(
  deps: Pick<AppDeps, "db" | "hub" | "push" | "outbound" | "socketMode">,
  channelId: string,
  authorId: string,
  input: SendInput,
  log: FastifyBaseLogger,
): Promise<SendResult> {
  const { db, hub, push } = deps;
  if (input.alsoSendToChannel && input.parentId === undefined) return { kind: "rejected", error: "invalid_input" };
  const members = await memberIds(db, channelId);
  const mention = mentionTargets(input.text, members, authorId);

  let result: number | "invalid_parent" | "duplicate";
  try {
    result = await db.transaction(async (tx) => {
      let parent: MessageRow | undefined;
      if (input.parentId !== undefined) {
        [parent] = await tx.select().from(messages).where(eq(messages.id, input.parentId)).for("update");
        if (!parent || parent.channelId !== channelId || parent.parentId !== null || parent.deletedAt) return "invalid_parent" as const;
      }
      const [inserted] = await tx
        .insert(messages)
        .values({
          channelId,
          userId: authorId,
          parentId: parent?.id ?? null,
          alsoSentToChannel: input.alsoSendToChannel,
          text: input.text,
          clientMsgId: input.clientMsgId,
          mentionsChannel: mention.channel,
          blocks: input.blocks ?? null,
        })
        .onConflictDoNothing({ target: [messages.userId, messages.clientMsgId] })
        .returning({ id: messages.id });
      if (!inserted) return "duplicate" as const;

      if (mention.targets.length > 0) {
        await tx.insert(mentions).values(mention.targets.map((userId) => ({ messageId: inserted.id, userId, channelId })));
      }
      if (input.fileIds.length > 0) {
        // Only the sender's own unattached uploads to this conversation.
        const attached = await tx
          .update(files)
          .set({ messageId: inserted.id })
          .where(and(inArray(files.id, input.fileIds), eq(files.uploaderId, authorId), eq(files.channelId, channelId), isNull(files.messageId)))
          .returning({ id: files.id });
        if (attached.length !== new Set(input.fileIds).size) throw new InvalidFiles();
      }
      if (parent) {
        await tx
          .update(messages)
          .set({ replyCount: sql`${messages.replyCount} + 1`, lastReplyAt: sql`now()` })
          .where(eq(messages.id, parent.id));
      }
      if (!parent || input.alsoSendToChannel) {
        await tx
          .update(channelMembers)
          .set({ lastReadMessageId: sql`greatest(${channelMembers.lastReadMessageId}, ${inserted.id})` })
          .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, authorId)));
      }
      return inserted.id;
    });
  } catch (err) {
    if (err instanceof InvalidFiles) return { kind: "rejected", error: "invalid_files" };
    throw err;
  }

  if (result === "invalid_parent") return { kind: "rejected", error: "invalid_parent" };
  if (result === "duplicate") {
    const [existing] = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(and(eq(messages.userId, authorId), eq(messages.clientMsgId, input.clientMsgId)));
    if (!existing || existing.channelId !== channelId) return { kind: "rejected", error: "client_msg_id_reused" };
    return { kind: "existing", message: (await loadMessage(db, existing.id))! };
  }

  const message = (await loadMessage(db, result))!;
  hub.publish({ users: members }, { type: "message.created", message });
  if (message.parentId !== null) {
    const parent = await loadMessage(db, message.parentId);
    if (parent) hub.publish({ users: members }, { type: "message.updated", message: parent });
  }
  // Off the response path: a slow push service never delays the sender.
  if (push) void notifyNewMessage(db, hub, push.send, message).catch((err) => log.error({ err }, "push notification failed"));
  void dispatchMessageEvents(deps, message, log).catch((err) => log.error({ err }, "app events failed"));
  return { kind: "created", message };
}

/**
 * Replaces a message's text (and, for apps, its blocks: undefined keeps them),
 * keeping read state for people still mentioned. Replies that replace a
 * clicked message are not marked edited.
 */
export async function editMessage(
  { db, hub }: Pick<AppDeps, "db" | "hub">,
  row: MessageRow,
  change: { text: string; blocks?: Block[] | null },
  { markEdited = true }: { markEdited?: boolean } = {},
): Promise<Message> {
  const members = await memberIds(db, row.channelId);
  const mention = mentionTargets(change.text, members, row.userId);
  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({
        text: change.text,
        mentionsChannel: mention.channel,
        ...(change.blocks !== undefined ? { blocks: change.blocks } : {}),
        ...(markEdited ? { editedAt: sql`now()` } : {}),
      })
      .where(eq(messages.id, row.id));
    await tx
      .delete(mentions)
      .where(and(eq(mentions.messageId, row.id), mention.targets.length > 0 ? notInArray(mentions.userId, mention.targets) : undefined));
    if (mention.targets.length > 0) {
      await tx
        .insert(mentions)
        .values(mention.targets.map((userId) => ({ messageId: row.id, userId, channelId: row.channelId })))
        .onConflictDoNothing();
    }
  });
  const message = (await loadMessage(db, row.id))!;
  hub.publish({ users: members }, { type: "message.updated", message });
  return message;
}

/** Deletes a message; a thread parent with replies stays as a placeholder. Deleting twice is a no-op. */
export async function deleteMessage({ db, hub, fileStore }: Pick<AppDeps, "db" | "hub" | "fileStore">, row: MessageRow): Promise<void> {
  if (row.deletedAt) return;
  const parentId = row.parentId;
  let removedFiles: string[] = [];
  const parentGone = await db.transaction(async (tx) => {
    await tx.update(messages).set({ deletedAt: sql`now()`, text: "", mentionsChannel: false }).where(eq(messages.id, row.id));
    await tx.delete(mentions).where(eq(mentions.messageId, row.id));
    await tx.delete(reactions).where(eq(reactions.messageId, row.id));
    removedFiles = (await tx.delete(files).where(eq(files.messageId, row.id)).returning({ key: files.storageKey })).map((f) => f.key);
    if (parentId === null) return false;
    const [parent] = await tx
      .update(messages)
      .set({
        replyCount: sql`${messages.replyCount} - 1`,
        lastReplyAt: sql`(select max(created_at) from messages where parent_id = ${parentId} and deleted_at is null)`,
      })
      .where(eq(messages.id, parentId))
      .returning({ replyCount: messages.replyCount, deletedAt: messages.deletedAt });
    return parent!.replyCount === 0 && parent!.deletedAt !== null;
  });
  await fileStore.remove(removedFiles);

  const members = await memberIds(db, row.channelId);
  const channelId = row.channelId;
  const publishUpdated = async (id: number) => {
    const message = await loadMessage(db, id);
    if (message) hub.publish({ users: members }, { type: "message.updated", message });
  };
  if (parentId === null && row.replyCount > 0) {
    // Stays as a placeholder so its thread remains reachable.
    await publishUpdated(row.id);
  } else {
    hub.publish({ users: members }, { type: "message.deleted", channelId, id: row.id, parentId });
  }
  if (parentId !== null) {
    if (parentGone) hub.publish({ users: members }, { type: "message.deleted", channelId, id: parentId, parentId: null });
    else await publishUpdated(parentId);
  }
}

/** Adds or removes one person's reaction; returns the message's reactions after the change. */
export async function setReaction(
  { db, hub }: Pick<AppDeps, "db" | "hub">,
  row: MessageRow,
  userId: string,
  emoji: string,
  add: boolean,
): Promise<Reaction[]> {
  if (add) await db.insert(reactions).values({ messageId: row.id, userId, emoji }).onConflictDoNothing();
  else await db.delete(reactions).where(and(eq(reactions.messageId, row.id), eq(reactions.userId, userId), eq(reactions.emoji, emoji)));
  const { reactions: list } = (await loadMessage(db, row.id))!;
  hub.publish({ users: await memberIds(db, row.channelId) }, { type: "reaction.updated", channelId: row.channelId, messageId: row.id, reactions: list });
  return list;
}
