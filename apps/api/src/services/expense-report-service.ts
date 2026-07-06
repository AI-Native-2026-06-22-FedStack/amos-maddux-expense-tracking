import {
  ExpenseReportRepository,
  createExpenseReportRepository
} from "../repository/expense-report-repository.js";
import type { ExpenseReportSelect } from "../db/schema.js";
import {
  CreateExpenseReportRequest,
  ExpenseReportResponse
} from "../schemas/expense-report.schema.js";

export interface ExpenseReportService {
  createDraftReport(request: CreateExpenseReportRequest): ExpenseReportResponse;
  findReport(id: string): ExpenseReportResponse | null;
}

class RepositoryExpenseReportService implements ExpenseReportService {
  public constructor(private readonly expenseReportRepository: ExpenseReportRepository) {}

  public createDraftReport(request: CreateExpenseReportRequest): ExpenseReportResponse {
    const report = this.expenseReportRepository.createDraftReport({
      tenant_id: request.tenantId,
      submitter_id: request.submitterId
    });

    return toExpenseReportResponse(report);
  }

  public findReport(id: string): ExpenseReportResponse | null {
    const report = this.expenseReportRepository.findById(id);

    return report === null ? null : toExpenseReportResponse(report);
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository()
): ExpenseReportService {
  return new RepositoryExpenseReportService(expenseReportRepository);
}

function toExpenseReportResponse(report: ExpenseReportSelect): ExpenseReportResponse {
  return {
    id: report.id,
    tenantId: report.tenant_id,
    submitterId: report.submitter_id,
    stage: report.current_stage,
    priority: report.priority,
    dueDate: report.due_date,
    onHold: report.on_hold,
    holdReason: report.hold_reason,
    createdAt: report.created_at.toISOString(),
    updatedAt: report.updated_at.toISOString()
  };
}
