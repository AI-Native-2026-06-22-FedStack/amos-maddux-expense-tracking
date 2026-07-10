ALTER TABLE "audit_entry" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "audit_entry" ADD COLUMN "result" text;
--> statement-breakpoint
UPDATE "audit_entry"
SET
	"reason" = COALESCE("details", 'Legacy synthetic audit entry migrated to the five-dimension schema.'),
	"result" = 'success';
--> statement-breakpoint
ALTER TABLE "audit_entry" ALTER COLUMN "reason" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_entry" ALTER COLUMN "result" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_entry" ADD CONSTRAINT "audit_entry_result_check" CHECK ("result" in ('success', 'failure'));
--> statement-breakpoint
ALTER TABLE "audit_entry" DROP COLUMN "details";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_entry_mutation()
RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_entry is append-only; UPDATE and DELETE are not allowed';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_trigger
		WHERE tgname = 'audit_entry_prevent_update'
	) THEN
		CREATE TRIGGER audit_entry_prevent_update
			BEFORE UPDATE ON audit_entry
			FOR EACH ROW
			EXECUTE FUNCTION prevent_audit_entry_mutation();
	END IF;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_trigger
		WHERE tgname = 'audit_entry_prevent_delete'
	) THEN
		CREATE TRIGGER audit_entry_prevent_delete
			BEFORE DELETE ON audit_entry
			FOR EACH ROW
			EXECUTE FUNCTION prevent_audit_entry_mutation();
	END IF;
END;
$$;
