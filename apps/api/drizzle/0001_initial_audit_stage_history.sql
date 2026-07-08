CREATE TABLE "audit_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"details" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_entry_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "stage_transition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_transition_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stage_transition_from_stage_check" CHECK ("stage_transition"."from_stage" is null or "stage_transition"."from_stage" in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')),
	CONSTRAINT "stage_transition_to_stage_check" CHECK ("stage_transition"."to_stage" in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')),
	CONSTRAINT "stage_transition_stage_change_check" CHECK ("stage_transition"."from_stage" is null or "stage_transition"."from_stage" <> "stage_transition"."to_stage")
);
--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transition" ADD CONSTRAINT "stage_transition_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
