import { faker } from "@faker-js/faker";

import { expenseReportPriorities, expenseReportStages } from "../../src/db/schema.js";
import type { ExpenseReportSelect } from "../../src/db/schema.js";

export type ExpenseReportStage = (typeof expenseReportStages)[number];
export type ExpenseReportPriority = (typeof expenseReportPriorities)[number];
export type ExpenseReportRow = ExpenseReportSelect;

export type ExpenseReportOverrides = Partial<ExpenseReportRow>;

export function makeExpenseReport(overrides: ExpenseReportOverrides = {}): ExpenseReportRow {
  const createdAt = faker.date.past();

  return {
    id: faker.string.uuid(),
    tenant_id: faker.string.uuid(),
    submitter_id: makeSyntheticActorId("submitter"),
    assigned_owner_id: null,
    manager_approver_id: null,
    ap_reviewer_id: null,
    payment_id: null,
    current_stage: "Drafted",
    priority: "Normal",
    due_date: formatDateOnly(faker.date.future()),
    on_hold: false,
    hold_reason: null,
    created_at: createdAt,
    updated_at: new Date(createdAt),
    ...overrides
  };
}

function makeSyntheticActorId(role: string): string {
  return `synthetic-${role}-${faker.string.uuid()}`;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
