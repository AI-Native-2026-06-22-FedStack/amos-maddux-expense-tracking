import { faker } from "@faker-js/faker";

export const expenseReportStages = [
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
] as const;

export const expenseReportPriorities = ["Low", "Normal", "High", "Urgent"] as const;

export type ExpenseReportStage = (typeof expenseReportStages)[number];
export type ExpenseReportPriority = (typeof expenseReportPriorities)[number];

export interface ExpenseReportRow {
  id: string;
  tenant_id: string;
  submitter_id: string;
  assigned_owner_id: string | null;
  manager_approver_id: string | null;
  ap_reviewer_id: string | null;
  payment_id: string | null;
  current_stage: ExpenseReportStage;
  priority: ExpenseReportPriority;
  due_date: string | null;
  on_hold: boolean;
  hold_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

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
