import { randomUUID } from "node:crypto";

import type { ExpenseReportInsert, ExpenseReportSelect } from "../db/schema.js";

export interface ExpenseReportRepository {
  createDraftReport(report: ExpenseReportInsert): ExpenseReportSelect;
  findById(id: string): ExpenseReportSelect | null;
}

class InMemoryExpenseReportRepository implements ExpenseReportRepository {
  private readonly reports = new Map<string, ExpenseReportSelect>();

  public createDraftReport(insert: ExpenseReportInsert): ExpenseReportSelect {
    const now = new Date();
    const report: ExpenseReportSelect = {
      id: randomUUID(),
      tenant_id: insert.tenant_id,
      submitter_id: insert.submitter_id,
      assigned_owner_id: insert.assigned_owner_id ?? null,
      manager_approver_id: insert.manager_approver_id ?? null,
      ap_reviewer_id: insert.ap_reviewer_id ?? null,
      payment_id: insert.payment_id ?? null,
      current_stage: insert.current_stage ?? "Drafted",
      priority: insert.priority ?? "Normal",
      due_date: insert.due_date ?? null,
      on_hold: insert.on_hold ?? false,
      hold_reason: insert.hold_reason ?? null,
      created_at: now,
      updated_at: now
    };

    this.reports.set(report.id, report);

    return report;
  }

  public findById(id: string): ExpenseReportSelect | null {
    return this.reports.get(id) ?? null;
  }
}

export function createExpenseReportRepository(): ExpenseReportRepository {
  return new InMemoryExpenseReportRepository();
}
