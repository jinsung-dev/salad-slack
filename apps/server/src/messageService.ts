import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { parseMentions, type Block, type Message, type postMessageInput } from "@chatter/shared";
import type { z } from "zod";
import type { AppDeps } from "./app";
import { channelMembers, files, mentions, messages } from "./db/schema";
import { dispatchMessageEvents } from "./events";
import { notifyNewMessage } from "./notify";
import { loadMessage, memberIds } from "./queries";

// Single path for creating a message, used by people (REST) and webhooks:
// mentions, attachments, thread bookkeeping, realtime delivery and push.
// Callers check that the author may post in the channel first.

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

type MessageRow = typeof messages.$inferSelect;

export async function sendMessage(
  { db, hub, push, outbound }: Pick<AppDeps, "db" | "hub" | "push" | "outbound">,
  channelId: string,
  authorId: string,
  input: SendInput,
  log: FastifyBaseLogger,
): Promise<SendResult> {
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
  void dispatchMessageEvents(db, outbound, message, log).catch((err) => log.error({ err }, "app events failed"));
  return { kind: "created", message };
}
