-- Before workspaces, a server was one implicit team. Move that team into a
-- workspace: everyone becomes a member, the earliest account its owner, and
-- every channel belongs to it. A fresh database (no users) gets nothing.
-- The owner's email domain becomes the join domain, unless it is a public
-- mail service, so teammates can keep joining as they did before.
INSERT INTO "workspaces" ("name", "join_domain", "created_by")
SELECT 'SaladLab',
       CASE WHEN split_part(u."email", '@', 2) IN ('gmail.com', 'googlemail.com', 'naver.com', 'kakao.com', 'daum.net', 'hanmail.net', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com')
            THEN NULL ELSE lower(split_part(u."email", '@', 2)) END,
       u."id"
FROM (SELECT "id", "email" FROM "users" ORDER BY "created_at" LIMIT 1) u;
--> statement-breakpoint
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT w."id", u."id", CASE WHEN u."id" = w."created_by" THEN 'owner' ELSE 'member' END
FROM "workspaces" w CROSS JOIN "users" u;
--> statement-breakpoint
UPDATE "channels" SET "workspace_id" = (SELECT "id" FROM "workspaces" LIMIT 1) WHERE "workspace_id" IS NULL;
