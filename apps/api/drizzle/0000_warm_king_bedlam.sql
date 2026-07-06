CREATE TABLE "attachment_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"uploaded_by_id" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_metadata_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "attachment_metadata_tenant_report_id_id_unique" UNIQUE("tenant_id","expense_report_id","id"),
	CONSTRAINT "attachment_metadata_storage_key_unique" UNIQUE("tenant_id","storage_key"),
	CONSTRAINT "attachment_metadata_file_size_bytes_check" CHECK ("attachment_metadata"."file_size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"submitter_id" text NOT NULL,
	"assigned_owner_id" text,
	"manager_approver_id" text,
	"ap_reviewer_id" text,
	"payment_id" text,
	"current_stage" text DEFAULT 'Drafted' NOT NULL,
	"priority" text DEFAULT 'Normal' NOT NULL,
	"due_date" date,
	"on_hold" boolean DEFAULT false NOT NULL,
	"hold_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_report_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_report_current_stage_check" CHECK ("expense_report"."current_stage" in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')),
	CONSTRAINT "expense_report_priority_check" CHECK ("expense_report"."priority" in ('Low', 'Normal', 'High', 'Urgent')),
	CONSTRAINT "expense_report_hold_reason_check" CHECK (("expense_report"."on_hold" = false and "expense_report"."hold_reason" is null) or ("expense_report"."on_hold" = true and "expense_report"."hold_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "expense_line_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"merchant" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"category" text NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_cleared" boolean DEFAULT false NOT NULL,
	"deductible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_line_item_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "expense_line_item_tenant_report_id_id_unique" UNIQUE("tenant_id","expense_report_id","id"),
	CONSTRAINT "expense_line_item_amount_cents_check" CHECK ("expense_line_item"."amount_cents" > 0),
	CONSTRAINT "expense_line_item_currency_check" CHECK ("expense_line_item"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "expense_line_item_flag_state_check" CHECK ("expense_line_item"."flag_cleared" = false or "expense_line_item"."flagged" = true)
);
--> statement-breakpoint
CREATE TABLE "mileage_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"trip_date" date NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"miles" numeric(10, 2) NOT NULL,
	"business_purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mileage_entry_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "mileage_entry_miles_check" CHECK ("mileage_entry"."miles" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"expense_line_item_id" uuid NOT NULL,
	"attachment_metadata_id" uuid,
	"receipt_number" text,
	"merchant" text,
	"receipt_date" date,
	"amount_cents" integer,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "receipt_amount_cents_check" CHECK ("receipt"."amount_cents" is null or "receipt"."amount_cents" > 0),
	CONSTRAINT "receipt_currency_check" CHECK ("receipt"."currency" is null or "receipt"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "attachment_metadata" ADD CONSTRAINT "attachment_metadata_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD CONSTRAINT "expense_line_item_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mileage_entry" ADD CONSTRAINT "mileage_entry_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_report_fk" FOREIGN KEY ("tenant_id","expense_report_id") REFERENCES "public"."expense_report"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_line_item_report_fk" FOREIGN KEY ("tenant_id","expense_report_id","expense_line_item_id") REFERENCES "public"."expense_line_item"("tenant_id","expense_report_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_attachment_metadata_fk" FOREIGN KEY ("tenant_id","expense_report_id","attachment_metadata_id") REFERENCES "public"."attachment_metadata"("tenant_id","expense_report_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_report_case_queue_idx" ON "expense_report" USING btree ("tenant_id","current_stage","due_date");