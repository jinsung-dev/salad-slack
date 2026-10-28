import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { appParams, createAppInput, createCommandInput, updateAppInput, workspaceParams, type App, type CommandInfo } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { appView, hashToken, newAppToken, newBotToken, newSigningSecret } from "../apps";
import { apps, slashCommands, users } from "../db/schema";
import { addWorkspaceMember, removeWorkspaceMember, requireRole } from "../workspaces";

const commandParams = appParams.extend({ commandId: z.uuid() });

// Admins create and configure apps; everyone may list the commands they can run.
export async function appRoutes(app: FastifyInstance, { db, hub, socketMode }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  const ownApp = async (workspaceId: string, appId: string) =>
    (await db.select().from(apps).where(and(eq(apps.id, appId), eq(apps.workspaceId, workspaceId))))[0] ?? null;

  // An app comes with a bot user that joins the workspace as a member; its token is shown once.
  app.post("/api/workspaces/:workspaceId/apps", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const { name } = createAppInput.parse(req.body);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const token = newBotToken();
    const created = await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(users)
        .values({ email: `app-${randomUUID()}@bots.invalid`, displayName: name, kind: "bot" })
        .returning({ id: users.id });
      const [row] = await tx
        .insert(apps)
        .values({ workspaceId, name, botUserId: bot!.id, tokenHash: hashToken(token), signingSecret: newSigningSecret(), createdBy: req.user!.id })
        .returning();
      return row!;
    });
    await addWorkspaceMember(db, hub, workspaceId, created.botUserId, "member");
    return reply.code(201).send(await appView(db, created, { token }));
  });

  app.get("/api/workspaces/:workspaceId/apps", async (req, reply): Promise<App[] | undefined> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const rows = await db.select().from(apps).where(eq(apps.workspaceId, workspaceId)).orderBy(apps.createdAt);
    return Promise.all(rows.map((r) => appView(db, r)));
  });

  app.put("/api/workspaces/:workspaceId/apps/:appId", async (req, reply) => {
    const { workspaceId, appId } = appParams.parse(req.params);
    const input = updateAppInput.parse(req.body);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const row = await ownApp(workspaceId, appId);
    if (!row) return reply.code(404).send({ error: "app_not_found" });
    const [updated] = await db
      .update(apps)
      .set({
        name: input.name,
        scopes: [...new Set(input.scopes)],
        eventsUrl: input.eventsUrl,
        eventTypes: [...new Set(input.eventTypes)],
        interactivityUrl: input.interactivityUrl,
        socketMode: input.socketMode,
      })
      .where(eq(apps.id, appId))
      .returning();
    await db.update(users).set({ displayName: input.name }).where(eq(users.id, row.botUserId));
    if (row.socketMode && !input.socketMode) await socketMode.disconnect(appId);
    return appView(db, updated!);
  });

  // The old token stops working at once.
  app.post("/api/workspaces/:workspaceId/apps/:appId/token", async (req, reply) => {
    const { workspaceId, appId } = appParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    if (!(await ownApp(workspaceId, appId))) return reply.code(404).send({ error: "app_not_found" });
    const token = newBotToken();
    const [updated] = await db.update(apps).set({ tokenHash: hashToken(token) }).where(eq(apps.id, appId)).returning();
    return appView(db, updated!, { token });
  });

  // The app-level token opens Socket Mode connections; reissuing closes the open ones.
  app.post("/api/workspaces/:workspaceId/apps/:appId/app-token", async (req, reply) => {
    const { workspaceId, appId } = appParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    if (!(await ownApp(workspaceId, appId))) return reply.code(404).send({ error: "app_not_found" });
    const appToken = newAppToken();
    const [updated] = await db.update(apps).set({ appTokenHash: hashToken(appToken) }).where(eq(apps.id, appId)).returning();
    await socketMode.disconnect(appId);
    return appView(db, updated!, { appToken });
  });

  // Deleting an app ends its token, commands and events; its bot leaves the workspace but keeps authorship of past messages.
  app.delete("/api/workspaces/:workspaceId/apps/:appId", async (req, reply) => {
    const { workspaceId, appId } = appParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const row = await ownApp(workspaceId, appId);
    if (!row) return reply.code(404).send({ error: "app_not_found" });
    await db.delete(apps).where(eq(apps.id, appId));
    await socketMode.disconnect(appId);
    await removeWorkspaceMember(db, hub, workspaceId, row.botUserId);
    return reply.code(204).send();
  });

  app.post("/api/workspaces/:workspaceId/apps/:appId/commands", async (req, reply) => {
    const { workspaceId, appId } = appParams.parse(req.params);
    const input = createCommandInput.parse(req.body);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    const owner = await ownApp(workspaceId, appId);
    if (!owner) return reply.code(404).send({ error: "app_not_found" });
    // Socket Mode apps receive commands over their connection; others need a URL.
    if (!input.url && !owner.socketMode) return reply.code(400).send({ error: "command_url_required" });
    const [created] = await db
      .insert(slashCommands)
      .values({ appId, workspaceId, ...input })
      .onConflictDoNothing({ target: [slashCommands.workspaceId, slashCommands.command] })
      .returning();
    if (!created) return reply.code(409).send({ error: "command_taken" });
    return reply.code(201).send(created);
  });

  app.delete("/api/workspaces/:workspaceId/apps/:appId/commands/:commandId", async (req, reply) => {
    const { workspaceId, appId, commandId } = commandParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "admin"))) return;
    await db.delete(slashCommands).where(and(eq(slashCommands.id, commandId), eq(slashCommands.appId, appId), eq(slashCommands.workspaceId, workspaceId)));
    return reply.code(204).send();
  });

  // Members and guests alike may run commands, so all may see the list.
  app.get("/api/workspaces/:workspaceId/commands", async (req, reply): Promise<CommandInfo[] | undefined> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "guest"))) return;
    return db
      .select({ command: slashCommands.command, description: slashCommands.description, usageHint: slashCommands.usageHint, appName: apps.name })
      .from(slashCommands)
      .innerJoin(apps, eq(apps.id, slashCommands.appId))
      .where(eq(slashCommands.workspaceId, workspaceId))
      .orderBy(slashCommands.command);
  });
}

