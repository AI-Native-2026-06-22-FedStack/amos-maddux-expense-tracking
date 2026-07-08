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
    tenantId: faker.string.uuid(),
    submitterId: makeSyntheticActorId("submitter"),
    assignedOwnerId: null,
    managerApproverId: null,
    apReviewerId: null,
    paymentId: null,
    currentStage: "Drafted",
    priority: "Normal",
    dueDate: formatDateOnly(faker.date.future()),
    onHold: false,
    holdReason: null,
    createdAt: createdAt,
    updatedAt: new Date(createdAt),
    ...overrides
  };
}

function makeSyntheticActorId(role: string): string {
  return `synthetic-${role}-${faker.string.uuid()}`;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
