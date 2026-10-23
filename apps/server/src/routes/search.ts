import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { searchQuery, type MessagePage } from "@chatter/shared";
import type { AppDeps } from "../app";
import { loadMessages } from "../queries";

/** `%`, `_` and `\` are literal in a search word, not LIKE wildcards. */
const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function searchRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  });

  // Newest first, across every conversation the viewer can read: public
  // channels, and private channels and DMs they belong to.
  app.get("/api/search", async (req): Promise<MessagePage> => {
    const { q, channelId, authorId, from, to, before, limit } = searchQuery.parse(req.query);
    const words = q.normalize("NFC").split(/\s+/);
    const { rows } = await db.execute<{ id: string }>(sql`
      select m.id from messages m
      join channels c on c.id = m.channel_id
      left join channel_members cm on cm.channel_id = c.id and cm.user_id = ${req.user!.id}
      where (c.kind = 'public' or cm.user_id is not null)
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
