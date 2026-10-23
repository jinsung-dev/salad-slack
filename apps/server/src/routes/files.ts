import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { channelParams } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { files } from "../db/schema";
import { cleanFileName, cleanMimeType, contentDisposition, fileRef, isInline } from "../files";
import { channelAccess } from "../queries";

const fileParams = z.object({ id: z.uuid() });

export async function fileRoutes(app: FastifyInstance, { db, fileStore, maxFileBytes }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  // One file per request; it stays private to the uploader until a message attaches it.
  app.post("/api/channels/:id/files", async (req, reply) => {
    const { id } = channelParams.parse(req.params);
    const me = req.user!.id;
    const access = await channelAccess(db, id, me);
    if (!access) return reply.code(404).send({ error: "channel_not_found" });
    if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });

    const part = await req.file({ limits: { fileSize: maxFileBytes, files: 1 } });
    if (!part) return reply.code(400).send({ error: "no_file" });
    const tooLarge = () => reply.code(413).send({ error: "file_too_large", maxBytes: maxFileBytes });
    let stored: { key: string; size: number };
    try {
      stored = await fileStore.save(part.file);
    } catch (err) {
      if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
      throw err;
    }
    // A streamed part over the limit ends early with `truncated` rather than failing.
    if (part.file.truncated) {
      await fileStore.remove([stored.key]);
      return tooLarge();
    }
    const [row] = await db
      .insert(files)
      .values({
        uploaderId: me,
        channelId: id,
        name: cleanFileName(part.filename),
        mimeType: cleanMimeType(part.mimetype),
        size: stored.size,
        storageKey: stored.key,
      })
      .returning();
    return reply.code(201).send(fileRef(row!));
  });

  app.get("/api/files/:id", async (req, reply) => {
    const { id } = fileParams.parse(req.params);
    const me = req.user!.id;
    const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    // Unattached files belong to their uploader; attached ones to whoever can read the conversation.
    const visible = row && (row.messageId === null ? row.uploaderId === me : await channelAccess(db, row.channelId, me));
    if (!row || !visible) return reply.code(404).send({ error: "file_not_found" });

    const inline = isInline(row.mimeType);
    return reply
      .header("content-type", inline ? row.mimeType : "application/octet-stream")
      .header("content-length", row.size)
      .header("content-disposition", contentDisposition(inline ? "inline" : "attachment", row.name))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=86400")
      .send(fileStore.open(row.storageKey));
  });
}
