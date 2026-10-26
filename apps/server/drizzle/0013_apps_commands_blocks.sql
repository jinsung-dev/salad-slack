CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bot_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"signing_secret" text NOT NULL,
	"events_url" text,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"interactivity_url" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "apps_bot_user_uq" UNIQUE("bot_user_id")
);
--> statement-breakpoint
CREATE TABLE "response_urls" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" bigint,
	"user_id" uuid NOT NULL,
	"message_id" bigint,
	"uses_left" smallint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slash_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"command" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"usage_hint" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slash_commands_workspace_command_uq" UNIQUE("workspace_id","command")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "blocks" jsonb;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_urls" ADD CONSTRAINT "response_urls_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_urls" ADD CONSTRAINT "response_urls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_urls" ADD CONSTRAINT "response_urls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_urls" ADD CONSTRAINT "response_urls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_commands" ADD CONSTRAINT "slash_commands_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slash_commands" ADD CONSTRAINT "slash_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apps_workspace_id_idx" ON "apps" USING btree ("workspace_id");