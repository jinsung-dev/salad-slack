import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import {
  createWorkspaceInput,
  roleInput,
  updateWorkspaceInput,
  workspaceMemberParams,
  workspaceParams,
  type JoinableWorkspace,
  type Workspace,
} from "@chatter/shared";
import type { AppDeps } from "../app";
import { workspaceMembers, workspaces } from "../db/schema";
import { addWorkspaceMember, atLeast, memberView, removeWorkspaceMember, requireRole, workspaceMemberIds } from "../workspaces";

export async function workspaceRoutes(app: FastifyInstance, { db, hub }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  const emailDomain = (email: string) => email.split("@").at(-1)!.toLowerCase();

  app.get("/api/workspaces", async (req): Promise<Workspace[]> =>
    db
      .select({ id: workspaces.id, name: workspaces.name, joinDomain: workspaces.joinDomain, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, req.user!.id))
      .orderBy(workspaces.name),
  );

  // Anyone signed in can start a workspace and owns it, except outside guests.
  app.post("/api/workspaces", async (req, reply) => {
    const input = createWorkspaceInput.parse(req.body);
    if (req.user!.guestOnly) return reply.code(403).send({ error: "guest_account_only" });
    const me = req.user!.id;
    const created = await db.transaction(async (tx) => {
      const [ws] = await tx.insert(workspaces).values({ name: input.name, joinDomain: input.joinDomain, createdBy: me }).returning();
      await tx.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: me, role: "owner" });
      return ws!;
    });
    const result: Workspace = { id: created.id, name: created.name, joinDomain: created.joinDomain, role: "owner" };
    return reply.code(201).send(result);
  });

  /** Workspaces that admit the viewer's verified email domain without an invite. */
  app.get("/api/workspaces/joinable", async (req): Promise<JoinableWorkspace[]> => {
    if (req.user!.guestOnly) return [];
    const { rows } = await db.execute<{ id: string; name: string; member_count: number }>(sql`
      select w.id, w.name, (select count(*)::int from workspace_members where workspace_id = w.id) as member_count
      from workspaces w
      where w.join_domain = ${emailDomain(req.user!.email)}
        and not exists (select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = ${req.user!.id})
      order by w.name`);
    return rows.map((r) => ({ id: r.id, name: r.name, memberCount: r.member_count }));
  });

  app.post("/api/workspaces/:workspaceId/join", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    // Missing and not-joinable look the same.
    if (!ws || !ws.joinDomain || ws.joinDomain !== emailDomain(req.user!.email) || req.user!.guestOnly) return reply.code(404).send({ error: "workspace_not_found" });
    await addWorkspaceMember(db, hub, workspaceId, req.user!.id, "member");
    return reply.code(204).send();
  });

  app.put("/api/workspaces/:workspaceId", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const input = updateWorkspaceInput.parse(req.body);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    await db.update(workspaces).set({ name: input.name, joinDomain: input.joinDomain }).where(eq(workspaces.id, workspaceId));
    return reply.code(204).send();
  });

  // Admins manage everyone but the owner; only the owner makes admins.
  app.put("/api/workspaces/:workspaceId/members/:userId/role", async (req, reply) => {
    const { workspaceId, userId } = workspaceMemberParams.parse(req.params);
    const { role } = roleInput.parse(req.body);
    const myRole = await requireRole(db, reply, workspaceId, req.user!.id, "admin");
    if (!myRole) return;
    const target = await memberView(db, workspaceId, userId);
    if (!target) return reply.code(404).send({ error: "member_not_found" });
    if (target.isBot) return reply.code(400).send({ error: "managed_by_app" });
    if (target.guestOnly && role !== "guest") return reply.code(400).send({ error: "guest_account_only" });
    if (target.role === "owner" || userId === req.user!.id) return reply.code(403).send({ error: "forbidden" });
    if ((role === "admin" || target.role === "admin") && myRole !== "owner") return reply.code(403).send({ error: "forbidden" });

    await db.transaction(async (tx) => {
      await tx.update(workspaceMembers).set({ role }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
      // A guest keeps only conversations they were added to; leaving public channels they had joined.
      if (role === "guest") {
        await tx.execute(sql`
          delete from channel_members cm using channels c
          where cm.channel_id = c.id and c.workspace_id = ${workspaceId} and c.kind = 'public' and cm.user_id = ${userId}`);
      }
    });
    hub.publish({ users: await workspaceMemberIds(db, workspaceId) }, { type: "member.updated", workspaceId, member: { ...target, role } });
    return reply.code(204).send();
  });

  // Leave (yourself) or remove (admins). The owner stays; their conversations in the workspace end for the person removed.
  app.delete("/api/workspaces/:workspaceId/members/:userId", async (req, reply) => {
    const { workspaceId, userId } = workspaceMemberParams.parse(req.params);
    const me = req.user!.id;
    const myRole = await requireRole(db, reply, workspaceId, me, "guest");
    if (!myRole) return;
    const target = await memberView(db, workspaceId, userId);
    if (!target) return reply.code(404).send({ error: "member_not_found" });
    // An app's bot leaves when the app is deleted.
    if (target.isBot) return reply.code(400).send({ error: "managed_by_app" });
    const allowed = target.role !== "owner" && (userId === me || (atLeast(myRole, "admin") && (target.role !== "admin" || myRole === "owner")));
    if (!allowed) return reply.code(403).send({ error: "forbidden" });

    await removeWorkspaceMember(db, hub, workspaceId, userId);
    return reply.code(204).send();
  });

}
