import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
export const auditEntryResults = ["success", "failure"] as const;
export const glCodingStatuses = ["mapped", "unmapped"] as const;
export const managerReviewStatuses = ["pending", "approved", "rejected"] as const;
export const eventOutboxStatuses = ["pending", "in_progress", "sent"] as const;

export const role = pgTable(
  "role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("role_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("role_tenant_id_name_unique").on(table.tenantId, table.name)
  ]
);

export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    roleId: uuid("role_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true })
  },
  (table) => [
    unique("user_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("user_tenant_id_email_unique").on(table.tenantId, table.email),
    foreignKey({
      name: "user_role_fk",
      columns: [table.tenantId, table.roleId],
      foreignColumns: [role.tenantId, role.id]
    }).onDelete("restrict")
  ]
);

export const credential = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("credential_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("credential_tenant_id_user_id_unique").on(table.tenantId, table.userId),
    foreignKey({
      name: "credential_user_fk",
      columns: [table.tenantId, table.userId],
      foreignColumns: [user.tenantId, user.id]
    }).onDelete("cascade")
  ]
);

export const refreshToken = pgTable(
  "refresh_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("refresh_token_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("refresh_token_tenant_id_token_hash_unique").on(table.tenantId, table.tokenHash),
    foreignKey({
      name: "refresh_token_user_fk",
      columns: [table.tenantId, table.userId],
      foreignColumns: [user.tenantId, user.id]
    }).onDelete("cascade"),
    index("refresh_token_tenant_user_idx").on(table.tenantId, table.userId)
  ]
);

export const mfaEnrollment = pgTable(
  "mfa_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    encryptedTotpSecret: text("encrypted_totp_secret").notNull(),
    totpSecretKeyId: text("totp_secret_key_id").notNull(),
    lastAcceptedTotpTimeStep: integer("last_accepted_totp_time_step"),
    lastAcceptedTotpAt: timestamp("last_accepted_totp_at", { withTimezone: true }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true })
  },
  (table) => [
    unique("mfa_enrollment_tenant_id_id_unique").on(table.tenantId, table.id),
    unique("mfa_enrollment_tenant_id_user_id_unique").on(table.tenantId, table.userId),
    foreignKey({
      name: "mfa_enrollment_user_fk",
      columns: [table.tenantId, table.userId],
      foreignColumns: [user.tenantId, user.id]
    }).onDelete("cascade")
  ]
);

export const authAuditEntry = pgTable(
  "auth_audit_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id"),
    eventType: text("event_type").notNull(),
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("auth_audit_entry_tenant_id_id_unique").on(table.tenantId, table.id),
    index("auth_audit_entry_tenant_event_idx").on(table.tenantId, table.eventType),
    index("auth_audit_entry_tenant_user_idx").on(table.tenantId, table.userId)
  ]
);

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
    gl_coding_status: text("gl_coding_status", { enum: glCodingStatuses }),
    gl_code_id: uuid("gl_code_id"),
    gl_account_code: text("gl_account_code"),
    gl_account_name: text("gl_account_name"),
    gl_normal_balance: text("gl_normal_balance"),
    gl_unmapped_marker: text("gl_unmapped_marker"),
    deductible: boolean("deductible").notNull().default(false),
    manager_review_status: text("manager_review_status", {
      enum: managerReviewStatuses
    })
      .notNull()
      .default("pending"),
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
    ),
    check(
      "expense_line_item_gl_coding_status_check",
      sql`${table.gl_coding_status} is null or ${table.gl_coding_status} in ('mapped', 'unmapped')`
    ),
    check(
      "expense_line_item_gl_normal_balance_check",
      sql`${table.gl_normal_balance} is null or ${table.gl_normal_balance} in ('debit', 'credit')`
    ),
    check(
      "expense_line_item_manager_review_status_check",
      sql`${table.manager_review_status} in ('pending', 'approved', 'rejected')`
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
    reason: text("reason").notNull(),
    result: text("result", { enum: auditEntryResults }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    unique("audit_entry_tenant_id_id_unique").on(table.tenantId, table.id),
    foreignKey({
      name: "audit_entry_report_fk",
      columns: [table.tenantId, table.expenseReportId],
      foreignColumns: [expenseReport.tenantId, expenseReport.id]
    }).onDelete("restrict"),
    check("audit_entry_result_check", sql`${table.result} in ('success', 'failure')`)
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

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: eventOutboxStatuses }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("event_outbox_status_check", sql`${table.status} in ('pending', 'in_progress', 'sent')`),
    check(
      "event_outbox_sent_status_check",
      sql`(${table.status} = 'sent' and ${table.sentAt} is not null) or (${table.status} <> 'sent' and ${table.sentAt} is null)`
    ),
    index("event_outbox_due_unsent_idx")
      .on(table.status, table.nextAttemptAt, table.createdAt)
      .where(sql`${table.sentAt} is null`)
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
export type EventOutboxSelect = typeof eventOutbox.$inferSelect;
export type EventOutboxInsert = typeof eventOutbox.$inferInsert;
export type RoleSelect = typeof role.$inferSelect;
export type RoleInsert = typeof role.$inferInsert;
export type UserSelect = typeof user.$inferSelect;
export type UserInsert = typeof user.$inferInsert;
export type CredentialSelect = typeof credential.$inferSelect;
export type CredentialInsert = typeof credential.$inferInsert;
export type RefreshTokenSelect = typeof refreshToken.$inferSelect;
export type RefreshTokenInsert = typeof refreshToken.$inferInsert;
export type MfaEnrollmentSelect = typeof mfaEnrollment.$inferSelect;
export type MfaEnrollmentInsert = typeof mfaEnrollment.$inferInsert;
export type AuthAuditEntrySelect = typeof authAuditEntry.$inferSelect;
export type AuthAuditEntryInsert = typeof authAuditEntry.$inferInsert;
