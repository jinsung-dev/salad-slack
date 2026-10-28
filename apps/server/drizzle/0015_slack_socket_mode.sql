ALTER TABLE "slash_commands" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "socket_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "app_token_hash" text;--> statement-breakpoint
CREATE INDEX "messages_channel_id_created_at_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_appTokenHash_unique" UNIQUE("app_token_hash");