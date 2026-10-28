import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { preferencesInput, workspaceParams, type Member, type PresenceMap, type Preferences } from "@chatter/shared";
import type { AppDeps } from "../app";
import { users, workspaceMembers } from "../db/schema";
import { memberColumns, requireRole, toMember, workspaceMemberIds } from "../workspaces";

export async function userRoutes(app: FastifyInstance, { db, hub }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  // The workspace's people and app bots, for mentions, DMs and channel invites.
  app.get("/api/workspaces/:workspaceId/members", async (req, reply): Promise<Member[] | undefined> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "guest"))) return;
    const rows = await db
      .select(memberColumns)
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(users.displayName));
    return rows.map(toMember);
  });

  // Presence of this workspace's people only.
  app.get("/api/workspaces/:workspaceId/presence", async (req, reply): Promise<PresenceMap | undefined> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "guest"))) return;
    const members = new Set(await workspaceMemberIds(db, workspaceId));
    return Object.fromEntries(Object.entries(await hub.presence()).filter(([id]) => members.has(id)));
  });

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
