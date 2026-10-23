import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { searchQuery, type MessagePage } from "@chatter/shared";
import type { AppDeps } from "../app";
import { loadMessages } from "../queries";
import { requireRole } from "../workspaces";

/** `%`, `_` and `\` are literal in a search word, not LIKE wildcards. */
const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function searchRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  // Newest first, across every conversation of one workspace the viewer can
  // read: public channels (not for guests), and conversations they belong to.
  app.get("/api/search", async (req, reply): Promise<MessagePage | undefined> => {
    const { workspaceId, q, channelId, authorId, from, to, before, limit } = searchQuery.parse(req.query);
    if (!(await requireRole(db, reply, workspaceId, req.user!.id, "guest"))) return;
    const words = q.normalize("NFC").split(/\s+/);
    const { rows } = await db.execute<{ id: string }>(sql`
      select m.id from messages m
      join channels c on c.id = m.channel_id
      join workspace_members wm on wm.workspace_id = c.workspace_id and wm.user_id = ${req.user!.id}
      left join channel_members cm on cm.channel_id = c.id and cm.user_id = ${req.user!.id}
      where c.workspace_id = ${workspaceId}
        and ((c.kind = 'public' and wm.role <> 'guest') or cm.user_id is not null)
        and m.deleted_at is null
        and ${sql.join(
          words.map((w) => sql`m.text ilike ${likePattern(w)}`),
          sql` and `,
        )}
        ${channelId ? sql`and m.channel_id = ${channelId}` : sql``}
        ${authorId ? sql`and m.user_id = ${authorId}` : sql``}
        ${from ? sql`and m.created_at >= ${from}` : sql``}
        ${to ? sql`and m.created_at < ${to}` : sql``}
        ${before ? sql`and m.id < ${before}` : sql``}
      order by m.id desc
      limit ${limit + 1}`);
    const ids = rows.slice(0, limit).map((r) => Number(r.id));
    return { messages: await loadMessages(db, ids), hasMore: rows.length > limit };
  });
}
