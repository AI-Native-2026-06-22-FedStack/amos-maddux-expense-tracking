import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid
} from "drizzle-orm/pg-core";

export const expenseReportStages = [
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
] as const;

export const expenseReportPriorities = ["Low", "Normal", "High", "Urgent"] as const;

export const expenseReport = pgTable(
  "expense_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    submitterId: text("submitter_id").notNull(),
    assignedOwnerId: text("assigned_owner_id"),
    managerApproverId: text("manager_approver_id"),
    apReviewerId: text("ap_reviewer_id"),
    paymentId: text("payment_id"),
    currentStage: text("current_stage", { enum: expenseReportStages }).notNull().default("Drafted"),
    priority: text("priority", { enum: expenseReportPriorities }).notNull().default("Normal"),
    dueDate: date("due_date"),
    onHold: boolean("on_hold").notNull().default(false),
    holdReason: text("hold_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("expense_report_tenant_id_id_unique").on(table.tenantId, table.id),
    check(
      "expense_report_current_stage_check",
      sql`${table.currentStage} in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')`
    ),
    check(
      "expense_report_priority_check",
      sql`${table.priority} in ('Low', 'Normal', 'High', 'Urgent')`
    ),
    check(
      "expense_report_hold_reason_check",
      sql`(${table.onHold} = false and ${table.holdReason} is null) or (${table.onHold} = true and ${table.holdReason} is not null)`
    ),
    index("expense_report_case_queue_idx").on(table.tenantId, table.currentStage, table.dueDate)
  ]
);

export const lineItem = pgTable(
  "expense_line_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").notNull(),
    expense_report_id: uuid("expense_report_id").notNull(),
    merchant: text("merchant").notNull(),
    amount_cents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    category: text("category").notNull(),
    flagged: boolean("flagged").notNull().default(false),
    flag_cleared: boolean("flag_cleared").notNull().default(false),
    deductible: boolean("deductible").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("expense_line_item_tenant_id_id_unique").on(table.tenant_id, table.id),
    unique("expense_line_item_tenant_report_id_id_unique").on(
      table.tenant_id,
      table.expense_report_id,
      table.id
    ),
    foreignKey({
      name: "expense_line_item_report_fk",
      columns: [table.tenant_id, table.expense_report_id],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("cascade"),
    check("expense_line_item_amount_cents_check", sql`${table.amount_cents} > 0`),
    check("expense_line_item_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      "expense_line_item_flag_state_check",
      sql`${table.flag_cleared} = false or ${table.flagged} = true`
    )
  ]
);

export const attachmentMetadata = pgTable(
  "attachment_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").notNull(),
    expense_report_id: uuid("expense_report_id").notNull(),
    uploaded_by_id: text("uploaded_by_id").notNull(),
    file_name: text("file_name").notNull(),
    content_type: text("content_type").notNull(),
    file_size_bytes: integer("file_size_bytes").notNull(),
    storage_key: text("storage_key").notNull(),
    uploaded_at: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("attachment_metadata_tenant_id_id_unique").on(table.tenant_id, table.id),
    unique("attachment_metadata_tenant_report_id_id_unique").on(
      table.tenant_id,
      table.expense_report_id,
      table.id
    ),
    foreignKey({
      name: "attachment_metadata_report_fk",
      columns: [table.tenant_id, table.expense_report_id],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("cascade"),
    check("attachment_metadata_file_size_bytes_check", sql`${table.file_size_bytes} > 0`),
    unique("attachment_metadata_storage_key_unique").on(table.tenant_id, table.storage_key)
  ]
);

export const receipt = pgTable(
  "receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").notNull(),
    expense_report_id: uuid("expense_report_id").notNull(),
    expense_line_item_id: uuid("expense_line_item_id").notNull(),
    attachment_metadata_id: uuid("attachment_metadata_id"),
    receipt_number: text("receipt_number"),
    merchant: text("merchant"),
    receipt_date: date("receipt_date"),
    amount_cents: integer("amount_cents"),
    currency: text("currency"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("receipt_tenant_id_id_unique").on(table.tenant_id, table.id),
    foreignKey({
      name: "receipt_report_fk",
      columns: [table.tenant_id, table.expense_report_id],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "receipt_line_item_report_fk",
      columns: [table.tenant_id, table.expense_report_id, table.expense_line_item_id],
      foreignColumns: [lineItem.tenant_id, lineItem.expense_report_id, lineItem.id]
    }).onDelete("cascade"),
    foreignKey({
      name: "receipt_attachment_metadata_fk",
      columns: [table.tenant_id, table.expense_report_id, table.attachment_metadata_id],
      foreignColumns: [
        attachmentMetadata.tenant_id,
        attachmentMetadata.expense_report_id,
        attachmentMetadata.id
      ]
    }),
    check(
      "receipt_amount_cents_check",
      sql`${table.amount_cents} is null or ${table.amount_cents} > 0`
    ),
    check(
      "receipt_currency_check",
      sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`
    )
  ]
);

export const mileageEntry = pgTable(
  "mileage_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenant_id: uuid("tenant_id").notNull(),
    expense_report_id: uuid("expense_report_id").notNull(),
    trip_date: date("trip_date").notNull(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    miles: numeric("miles", { precision: 10, scale: 2 }).notNull(),
    business_purpose: text("business_purpose").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("mileage_entry_tenant_id_id_unique").on(table.tenant_id, table.id),
    foreignKey({
      name: "mileage_entry_report_fk",
      columns: [table.tenant_id, table.expense_report_id],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("cascade"),
    check("mileage_entry_miles_check", sql`${table.miles} > 0`)
  ]
);

export const auditEntry = pgTable(
  "audit_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    expenseReportId: uuid("expense_report_id").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    details: text("details"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("audit_entry_tenant_id_id_unique").on(table.tenantId, table.id),
    foreignKey({
      name: "audit_entry_report_fk",
      columns: [table.tenantId, table.expenseReportId],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("restrict")
  ]
);

export const stageTransition = pgTable(
  "stage_transition",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    expenseReportId: uuid("expense_report_id").notNull(),
    fromStage: text("from_stage", { enum: expenseReportStages }),
    toStage: text("to_stage", { enum: expenseReportStages }).notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("stage_transition_tenant_id_id_unique").on(table.tenantId, table.id),
    foreignKey({
      name: "stage_transition_report_fk",
      columns: [table.tenantId, table.expenseReportId],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("restrict"),
    check(
      "stage_transition_from_stage_check",
      sql`${table.fromStage} is null or ${table.fromStage} in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')`
    ),
    check(
      "stage_transition_to_stage_check",
      sql`${table.toStage} in ('Drafted', 'Submitted', 'Manager Approval', 'AP Review', 'Paid', 'Reconciled')`
    ),
    check(
      "stage_transition_stage_change_check",
      sql`${table.fromStage} is null or ${table.fromStage} <> ${table.toStage}`
    )
  ]
);

export type ExpenseReportSelect = typeof expenseReport.$inferSelect;
export type ExpenseReportInsert = typeof expenseReport.$inferInsert;
export type LineItemSelect = typeof lineItem.$inferSelect;
export type LineItemInsert = typeof lineItem.$inferInsert;
export type ReceiptSelect = typeof receipt.$inferSelect;
export type ReceiptInsert = typeof receipt.$inferInsert;
export type MileageEntrySelect = typeof mileageEntry.$inferSelect;
export type MileageEntryInsert = typeof mileageEntry.$inferInsert;
export type AuditEntrySelect = typeof auditEntry.$inferSelect;
export type AuditEntryInsert = typeof auditEntry.$inferInsert;
export type StageTransitionSelect = typeof stageTransition.$inferSelect;
export type StageTransitionInsert = typeof stageTransition.$inferInsert;
