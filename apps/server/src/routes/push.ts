import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { pushSubscriptionInput, pushUnsubscribeInput } from "@chatter/shared";
import type { AppDeps } from "../app";
import { pushSubscriptions } from "../db/schema";

export async function pushRoutes(app: FastifyInstance, { db, push }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  app.get("/api/push/key", async (_req, reply) => {
    if (!push) return reply.code(404).send({ error: "push_disabled" });
    return { publicKey: push.publicKey };
  });

  // An endpoint belongs to one browser profile; re-subscribing moves it to whoever is signed in there now.
  app.post("/api/push/subscriptions", async (req, reply) => {
    const { endpoint, keys } = pushSubscriptionInput.parse(req.body);
    const values = { endpoint, userId: req.user!.id, p256dh: keys.p256dh, auth: keys.auth };
    await db.insert(pushSubscriptions).values(values).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
    return reply.code(204).send();
  });

  app.delete("/api/push/subscriptions", async (req, reply) => {
    const { endpoint } = pushUnsubscribeInput.parse(req.body);
    await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, req.user!.id)));
    return reply.code(204).send();
  });
}
