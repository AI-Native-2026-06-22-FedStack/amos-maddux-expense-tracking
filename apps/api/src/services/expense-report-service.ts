import { GlCodingEngineClient, createGlCodingEngineClient } from "../engine/gl-client.js";
import { ConflictError, NotFoundError } from "../errors/problem-json.js";
import {
  ExpenseReportRepository,
  ExpenseReportForSubmit,
  createExpenseReportRepository
} from "../repository/expense-report-repository.js";
import {
  CreateExpenseReportRequest,
  ExpenseReportResponse
} from "../schemas/expense-report.schema.js";

export type CreateDraftExpenseReportRequest = CreateExpenseReportRequest & {
  tenantId: string;
  submitterId: string;
};

export interface ExpenseReportService {
  createDraftReport(request: CreateDraftExpenseReportRequest): Promise<ExpenseReportResponse>;
  findReport(id: string, tenantId: string): Promise<ExpenseReportResponse | null>;
  submitForApReview(request: SubmitExpenseReportRequest): Promise<ExpenseReportResponse>;
}

export interface SubmitExpenseReportRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  bearerToken: string;
}

class RepositoryExpenseReportService implements ExpenseReportService {
  public constructor(
    private readonly expenseReportRepository: ExpenseReportRepository,
    private readonly glCodingEngineClient: GlCodingEngineClient
  ) {}

  public async createDraftReport(
    request: CreateDraftExpenseReportRequest
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

  public async submitForApReview(
    request: SubmitExpenseReportRequest
  ): Promise<ExpenseReportResponse> {
    const report = await this.expenseReportRepository.findForSubmit(
      request.expenseReportId,
      request.tenantId
    );

    if (report === null) {
      throw new NotFoundError("Expense Report not found.");
    }

    if (report.currentStage !== "Drafted") {
      throw new ConflictError("Expense Report must be Drafted before submit.");
    }

    const glCodingResponse = await this.glCodingEngineClient.codeExpenseReport(
      toGlCodingRequest(report),
      request.bearerToken
    );
    const submittedReport = await this.expenseReportRepository.submitForApReview({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      flaggedLineItemIds: readFlaggedLineItemIds(glCodingResponse)
    });

    return submittedReport;
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository(),
  glCodingEngineClient: GlCodingEngineClient = createGlCodingEngineClient()
): ExpenseReportService {
  return new RepositoryExpenseReportService(expenseReportRepository, glCodingEngineClient);
}

function toGlCodingRequest(report: ExpenseReportForSubmit) {
  return {
    line_items: report.lineItems.map((item) => ({
      line_item_id: item.id,
      amount: centsToUsdString(item.amount_cents),
      currency: item.currency,
      category: item.category
    })),
    mileage_entries: report.mileageEntries.map((entry) => ({
      mileage_entry_id: entry.id,
      miles: String(entry.miles),
      category: "Mileage" as const
    }))
  };
}

function centsToUsdString(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function readFlaggedLineItemIds(response: unknown): string[] {
  if (!isRecord(response) || !Array.isArray(response.coded_line_items)) {
    return [];
  }

  return response.coded_line_items.filter(isFlaggedCodedLineItem).map((item) => item.line_item_id);
}

function isFlaggedCodedLineItem(value: unknown): value is { line_item_id: string; flagged: true } {
  return isRecord(value) && typeof value.line_item_id === "string" && value.flagged === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
