import {
  ExpenseReportRepository,
  createExpenseReportRepository
} from "../repository/expense-report-repository.js";
import {
  CreateExpenseReportRequest,
  ExpenseReportResponse
} from "../schemas/expense-report.schema.js";

export interface ExpenseReportService {
  createDraftReport(request: CreateExpenseReportRequest): Promise<ExpenseReportResponse>;
  findReport(id: string, tenantId: string): Promise<ExpenseReportResponse | null>;
}

class RepositoryExpenseReportService implements ExpenseReportService {
  public constructor(private readonly expenseReportRepository: ExpenseReportRepository) {}

  public async createDraftReport(
    request: CreateExpenseReportRequest
  ): Promise<ExpenseReportResponse> {
    const report = await this.expenseReportRepository.createDraftReport({
      ...request,
      currentStage: "Drafted"
    });

    return report;
  }

  public async findReport(id: string, tenantId: string): Promise<ExpenseReportResponse | null> {
    const report = await this.expenseReportRepository.findById(id, tenantId);

    return report;
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository()
): ExpenseReportService {
  return new RepositoryExpenseReportService(expenseReportRepository);
}
