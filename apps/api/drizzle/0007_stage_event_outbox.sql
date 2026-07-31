CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_outbox_status_check" CHECK ("event_outbox"."status" in ('pending', 'in_progress', 'sent', 'dead_lettered')),
	CONSTRAINT "event_outbox_sent_status_check" CHECK (("event_outbox"."status" = 'sent' and "event_outbox"."sent_at" is not null) or ("event_outbox"."status" <> 'sent' and "event_outbox"."sent_at" is null))
);
--> statement-breakpoint
CREATE INDEX "event_outbox_due_unsent_idx" ON "event_outbox" USING btree ("status","next_attempt_at","created_at") WHERE "event_outbox"."sent_at" is null;
