ALTER TABLE "invites" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN "guest_days" smallint;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_expires_at_idx" ON "workspace_members" USING btree ("expires_at");