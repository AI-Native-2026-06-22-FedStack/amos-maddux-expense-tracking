CREATE TABLE "auth_audit_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_audit_entry_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "mfa_enrollment" ADD COLUMN "last_accepted_totp_time_step" integer;--> statement-breakpoint
ALTER TABLE "mfa_enrollment" ADD COLUMN "last_accepted_totp_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "auth_audit_entry_tenant_event_idx" ON "auth_audit_entry" USING btree ("tenant_id","event_type");--> statement-breakpoint
CREATE INDEX "auth_audit_entry_tenant_user_idx" ON "auth_audit_entry" USING btree ("tenant_id","user_id");