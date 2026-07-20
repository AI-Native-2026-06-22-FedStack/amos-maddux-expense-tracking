ALTER TABLE "expense_line_item" ADD COLUMN "gl_coding_status" text;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD COLUMN "gl_code_id" uuid;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD COLUMN "gl_account_code" text;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD COLUMN "gl_account_name" text;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD COLUMN "gl_normal_balance" text;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD COLUMN "gl_unmapped_marker" text;
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD CONSTRAINT "expense_line_item_gl_coding_status_check" CHECK ("gl_coding_status" is null or "gl_coding_status" in ('mapped', 'unmapped'));
--> statement-breakpoint
ALTER TABLE "expense_line_item" ADD CONSTRAINT "expense_line_item_gl_normal_balance_check" CHECK ("gl_normal_balance" is null or "gl_normal_balance" in ('debit', 'credit'));
