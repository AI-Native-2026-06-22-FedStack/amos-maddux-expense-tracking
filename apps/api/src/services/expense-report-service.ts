import {
  ExpenseReportRepository,
  createExpenseReportRepository
} from "../repository/expense-report-repository.js";
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
    return this.expenseReportRepository.createDraftReport(request);
  }

  public findReport(id: string): ExpenseReportResponse | null {
    return this.expenseReportRepository.findById(id);
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository()
): ExpenseReportService {
  return new RepositoryExpenseReportService(expenseReportRepository);
}
