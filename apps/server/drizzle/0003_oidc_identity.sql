ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_oidc_identity_uq" UNIQUE("oidc_issuer","oidc_subject");