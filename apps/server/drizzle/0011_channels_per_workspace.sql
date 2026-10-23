ALTER TABLE "channels" DROP CONSTRAINT "channels_name_unique";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_dmKey_unique";--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_name_uq" UNIQUE("workspace_id","name");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_dm_key_uq" UNIQUE("workspace_id","dm_key");