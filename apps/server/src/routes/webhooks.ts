import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { createWebhookInput, webhookMessageInput, workspaceParams, type Webhook } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { channelMembers, channels, users, webhooks } from "../db/schema";
import { sendMessage } from "../messageService";
import { requireRole } from "../workspaces";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const webhookParams = workspaceParams.extend({ webhookId: z.uuid() });
const tokenParams = z.object({ token: z.string().min(16).max(128) });

type WebhookRow = typeof webhooks.$inferSelect;
const toWebhook = (row: WebhookRow): Webhook => ({ id: row.id, channelId: row.channelId, name: row.name, createdAt: row.createdAt.toISOString() });

export async function webhookRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, publicUrl } = deps;
  const origin = (req: FastifyRequest) => publicUrl ?? `${req.protocol}://${req.host}`;

  // Management is for admins. Each webhook posts as its own bot user, named after it.
  await app.register(async (admin) => {
    admin.addHook("preHandler", async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    });

    admin.post("/api/workspaces/:workspaceId/webhooks", async (req, reply) => {
      const { workspaceId } = workspaceParams.parse(req.params);
      const input = createWebhookInput.parse(req.body);
      if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
      const [channel] = await db.select().from(channels).where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, workspaceId)));
      if (!channel || channel.kind === "dm") return reply.code(400).send({ error: "invalid_channel" });

      const token = randomBytes(24).toString("base64url");
      const row = await db.transaction(async (tx) => {
        const [bot] = await tx
          .insert(users)
          .values({ email: `webhook-${randomUUID()}@bots.invalid`, displayName: input.name, kind: "bot" })
          .returning({ id: users.id });
        await tx.insert(channelMembers).values({ channelId: channel.id, userId: bot!.id });
        const [hook] = await tx
          .insert(webhooks)
          .values({ workspaceId, channelId: channel.id, botUserId: bot!.id, name: input.name, tokenHash: hashToken(token), createdBy: req.user!.id })
          .returning();
        return hook!;
      });
      return reply.code(201).send({ ...toWebhook(row), url: `${origin(req)}/api/hooks/${token}` } satisfies Webhook);
    });

    admin.get("/api/workspaces/:workspaceId/webhooks", async (req, reply): Promise<Webhook[] | undefined> => {
      const { workspaceId } = workspaceParams.parse(req.params);
      if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
      const rows = await db.select().from(webhooks).where(eq(webhooks.workspaceId, workspaceId)).orderBy(desc(webhooks.createdAt));
      return rows.map(toWebhook);
    });

    // Revoking deletes the secret; the bot user stays so past messages keep their author.
    admin.delete("/api/workspaces/:workspaceId/webhooks/:webhookId", async (req, reply) => {
      const { workspaceId, webhookId } = webhookParams.parse(req.params);
      if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
      await db.delete(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)));
      return reply.code(204).send();
    });
  });

  // The secret URL is the credential: no session. Rate limited per URL.
  app.post(
    "/api/hooks/:token",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => (req.params as { token?: string }).token ?? req.ip } } },
    async (req, reply) => {
      const { token } = tokenParams.parse(req.params);
      const [hook] = await db.select().from(webhooks).where(eq(webhooks.tokenHash, hashToken(token)));
      if (!hook) return reply.code(404).send({ error: "webhook_not_found" });
      const { text } = webhookMessageInput.parse(req.body);
      const result = await sendMessage(
        deps,
        hook.channelId,
        hook.botUserId,
        { text, clientMsgId: randomUUID(), alsoSendToChannel: false, fileIds: [] },
        req.log,
      );
      if (result.kind === "rejected") return reply.code(400).send({ error: result.error });
      return reply.code(201).send({ id: result.message.id });
    },
  );
}
