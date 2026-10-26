import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { appReply, blockActionInput, channelParams, invokeCommandInput, messageParams, type Block } from "@chatter/shared";
import { z } from "zod";
import type { AppDeps } from "../app";
import { appByBot, applyReply, botAuthor, issueResponseUrl, redeemResponseUrl, sendEphemeral } from "../apps";
import { apps, messages, slashCommands } from "../db/schema";
import { OutboundError, postSigned } from "../outbound";
import { channelAccess } from "../queries";

const tokenParams = z.object({ token: z.string().min(16).max(128) });

const FAILURE_TEXT: Record<string, string> = {
  timeout: "앱이 3초 안에 응답하지 않았습니다. 잠시 뒤 답이 올 수도 있습니다.",
  blocked_address: "앱 주소가 내부 네트워크를 가리켜 호출하지 않았습니다.",
  invalid_url: "앱 주소가 올바르지 않습니다 (HTTPS 필요).",
};

/** Whether a message's blocks contain a button with this action id. */
const hasAction = (blocks: Block[] | null, actionId: string) =>
  (blocks ?? []).some((b) => b.type === "actions" && b.elements.some((e) => e.actionId === actionId));

export async function interactionRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, hub, publicUrl, outbound } = deps;
  const origin = (req: FastifyRequest) => publicUrl ?? `${req.protocol}://${req.host}`;

  // People run commands and click buttons from a session.
  await app.register(async (people) => {
    people.addHook("preHandler", async (req, reply) => {
      if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
    });

    // `/command text`: the app answers within 3 seconds, or later through the response URL.
    people.post("/api/channels/:id/commands", async (req, reply) => {
      const { id } = channelParams.parse(req.params);
      const input = invokeCommandInput.parse(req.body);
      const me = req.user!;
      const access = await channelAccess(db, id, me.id);
      if (!access) return reply.code(404).send({ error: "channel_not_found" });
      if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });
      const [found] = await db
        .select({ command: slashCommands, app: apps })
        .from(slashCommands)
        .innerJoin(apps, eq(apps.id, slashCommands.appId))
        .where(and(eq(slashCommands.workspaceId, access.channel.workspaceId), eq(slashCommands.command, input.command)));
      if (!found) return reply.code(404).send({ error: "unknown_command" });

      const target = { channelId: id, parentId: input.parentId, userId: me.id };
      const payload = {
        type: "slash_command",
        command: `/${found.command.command}`,
        text: input.text,
        appId: found.app.id,
        workspaceId: access.channel.workspaceId,
        channelId: id,
        parentId: input.parentId,
        user: { id: me.id, displayName: me.displayName },
        responseUrl: await issueResponseUrl(db, origin(req), found.app, target),
      };
      try {
        const res = await postSigned(found.command.url, payload, found.app.signingSecret, outbound);
        if (res.status < 200 || res.status >= 300) throw new OutboundError("network", `status ${res.status}`);
        // An empty 2xx means "received; I will answer through the response URL".
        if (res.json !== null) {
          const parsed = appReply.safeParse(res.json);
          if (!parsed.success) throw new OutboundError("network", "invalid reply");
          await applyReply(deps, found.app, target, parsed.data, req.log);
        }
      } catch (err) {
        const reason = err instanceof OutboundError ? err.reason : "network";
        sendEphemeral(hub, me.id, {
          channelId: id,
          parentId: input.parentId,
          author: await botAuthor(db, found.app),
          text: FAILURE_TEXT[reason] ?? `/${found.command.command} 명령을 처리하지 못했습니다.`,
        });
      }
      return reply.code(204).send();
    });

    // A click on a button an app put in a message; the app decides what happens.
    people.post("/api/messages/:id/actions", async (req, reply) => {
      const { id } = messageParams.parse(req.params);
      const { actionId, value } = blockActionInput.parse(req.body);
      const me = req.user!;
      const [message] = await db.select().from(messages).where(eq(messages.id, id));
      const access = message ? await channelAccess(db, message.channelId, me.id) : null;
      if (!message || !access || message.deletedAt) return reply.code(404).send({ error: "message_not_found" });
      if (!access.isMember) return reply.code(403).send({ error: "not_a_member" });
      const owner = await appByBot(db, message.userId);
      if (!owner || !hasAction(message.blocks, actionId)) return reply.code(400).send({ error: "unknown_action" });
      if (!owner.interactivityUrl) return reply.code(400).send({ error: "app_not_interactive" });

      const target = { channelId: message.channelId, parentId: message.parentId, userId: me.id, messageId: message.id };
      const payload = {
        type: "block_actions",
        appId: owner.id,
        workspaceId: owner.workspaceId,
        channelId: message.channelId,
        user: { id: me.id, displayName: me.displayName },
        messageId: message.id,
        action: { actionId, value: value ?? null },
        responseUrl: await issueResponseUrl(db, origin(req), owner, target),
      };
      try {
        const res = await postSigned(owner.interactivityUrl, payload, owner.signingSecret, outbound);
        if (res.status < 200 || res.status >= 300) throw new OutboundError("network", `status ${res.status}`);
        if (res.json !== null) {
          const parsed = appReply.safeParse(res.json);
          if (parsed.success) await applyReply(deps, owner, target, parsed.data, req.log);
        }
      } catch (err) {
        const reason = err instanceof OutboundError ? err.reason : "network";
        sendEphemeral(hub, me.id, {
          channelId: message.channelId,
          parentId: message.parentId,
          author: await botAuthor(db, owner),
          text: FAILURE_TEXT[reason] ?? "앱이 버튼을 처리하지 못했습니다.",
        });
      }
      return reply.code(204).send();
    });
  });

  // Late replies from apps: the URL is the credential, valid for a few uses within 30 minutes.
  app.post("/api/response-urls/:token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { token } = tokenParams.parse(req.params);
    const answer = appReply.parse(req.body);
    const redeemed = await redeemResponseUrl(db, token);
    if (!redeemed) return reply.code(404).send({ error: "response_url_invalid" });
    await applyReply(deps, redeemed.app, redeemed.target, answer, req.log);
    return reply.code(204).send();
  });
}
