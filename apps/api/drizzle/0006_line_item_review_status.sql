ALTER TABLE "expense_line_item" ADD COLUMN "manager_review_status" text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD CONSTRAINT "expense_line_item_manager_review_status_check" CHECK ("manager_review_status" in ('pending', 'approved', 'rejected'));
