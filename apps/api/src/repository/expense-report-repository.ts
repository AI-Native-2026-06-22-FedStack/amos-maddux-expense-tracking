import { randomUUID } from "node:crypto";

import {
  CreateExpenseReportRequest,
  ExpenseReportResponse
} from "../schemas/expense-report.schema.js";

export interface ExpenseReportRepository {
  createDraftReport(request: CreateExpenseReportRequest): ExpenseReportResponse;
  findById(id: string): ExpenseReportResponse | null;
}

class InMemoryExpenseReportRepository implements ExpenseReportRepository {
  private readonly reports = new Map<string, ExpenseReportResponse>();

  public createDraftReport(request: CreateExpenseReportRequest): ExpenseReportResponse {
    const now = new Date().toISOString();
    const report: ExpenseReportResponse = {
      id: randomUUID(),
      tenantId: request.tenantId,
      submitterId: request.submitterId,
      stage: "Drafted",
      priority: "Normal",
      dueDate: null,
      onHold: false,
      holdReason: null,
      createdAt: now,
      updatedAt: now
    };

    this.reports.set(report.id, report);

    return report;
  }

  public findById(id: string): ExpenseReportResponse | null {
    return this.reports.get(id) ?? null;
  }
}

export function createExpenseReportRepository(): ExpenseReportRepository {
  return new InMemoryExpenseReportRepository();
}
