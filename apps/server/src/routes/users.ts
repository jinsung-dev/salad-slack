import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { preferencesInput, type Member, type Preferences } from "@chatter/shared";
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

  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

  app.get("/api/me/preferences", async (req): Promise<Preferences> => {
    const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
    return {
      timeZone: u!.timeZone,
      quietHours: { enabled: u!.quietHoursEnabled, start: clock(u!.quietHoursStart), end: clock(u!.quietHoursEnd) },
    };
  });

  app.put("/api/me/preferences", async (req, reply) => {
    const prefs = preferencesInput.parse(req.body);
    await db
      .update(users)
      .set({
        timeZone: prefs.timeZone,
        quietHoursEnabled: prefs.quietHours.enabled,
        quietHoursStart: minutes(prefs.quietHours.start),
        quietHoursEnd: minutes(prefs.quietHours.end),
      })
      .where(eq(users.id, req.user!.id));
    return reply.code(204).send();
  });
}
