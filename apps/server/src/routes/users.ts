import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import type { Member } from "@chatter/shared";
import type { AppDeps } from "../app";
import { users } from "../db/schema";

export async function userRoutes(app: FastifyInstance, { db, hub }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  // Single workspace: everyone is in the directory (Phase 4 scopes this per workspace).
  app.get("/api/users", async (): Promise<Member[]> =>
    db.select({ id: users.id, displayName: users.displayName }).from(users).orderBy(asc(users.displayName)),
  );

  app.get("/api/presence", async () => hub.presence());
}
