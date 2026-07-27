import { GlCodingEngineClient, createGlCodingEngineClient } from "../engine/gl-client.js";
import {
  BoundaryContractError,
  ConflictError,
  ForbiddenError,
  NotFoundError
} from "../errors/problem-json.js";
import {
  ExpenseReportRepository,
  ExpenseReportForSubmit,
  createExpenseReportRepository
} from "../repository/expense-report-repository.js";
import {
  ApprovalQueueLineItem,
  CaseQueueItem,
  CaseQueueStageSummary,
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
  listApprovalQueueLineItems(request: ApprovalQueueReadRequest): Promise<ApprovalQueueLineItem[]>;
  listCaseQueue(tenantId: string): Promise<CaseQueueItem[]>;
  listCaseQueueRollup(request: ApprovalQueueReadRequest): Promise<CaseQueueStageSummary[]>;
  approveLineItem(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem>;
  rejectLineItem(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem>;
  clearLineItemFlag(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem>;
  updateLineItemDeductible(request: UpdateLineItemDeductibleServiceRequest): Promise<ApprovalQueueLineItem>;
  submit(request: SubmitExpenseReportRequest): Promise<ExpenseReportResponse>;
  submitForApReview(request: SubmitExpenseReportRequest): Promise<ExpenseReportResponse>;
  advance(request: TransitionExpenseReportRequest): Promise<ExpenseReportResponse>;
  reject(request: RejectExpenseReportRequest): Promise<ExpenseReportResponse>;
}

export interface SubmitExpenseReportRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  bearerToken: string;
}

export interface TransitionExpenseReportRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  roles: string[];
  reason?: string;
}

export type RejectExpenseReportRequest = TransitionExpenseReportRequest & {
  reason: string;
};

export interface ApprovalQueueReadRequest {
  tenantId: string;
  roles: string[];
}

export interface LineItemReviewRequest {
  expenseReportId: string;
  lineItemId: string;
  tenantId: string;
  actorId: string;
  roles: string[];
}

export type UpdateLineItemDeductibleServiceRequest = LineItemReviewRequest & {
  deductible: boolean;
};

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

  public async listCaseQueue(tenantId: string): Promise<CaseQueueItem[]> {
    return this.expenseReportRepository.listCaseQueue(tenantId);
  }

  public async listCaseQueueRollup(
    request: ApprovalQueueReadRequest
  ): Promise<CaseQueueStageSummary[]> {
    if (!canReview(request.roles)) {
      throw new ForbiddenError("Employee cannot read the Finance Dashboard rollup.");
    }

    return this.expenseReportRepository.listCaseQueueRollup(request.tenantId);
  }

  public async listApprovalQueueLineItems(
    request: ApprovalQueueReadRequest
  ): Promise<ApprovalQueueLineItem[]> {
    if (!canReview(request.roles)) {
      throw new ForbiddenError("Employee cannot read the Approval Queue.");
    }

    return this.expenseReportRepository.listApprovalQueueLineItems(request.tenantId);
  }

  public async approveLineItem(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem> {
    assertCanReviewLineItems(request.roles);

    return this.expenseReportRepository.approveLineItem(request);
  }

  public async rejectLineItem(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem> {
    assertCanReviewLineItems(request.roles);

    return this.expenseReportRepository.rejectLineItem(request);
  }

  public async clearLineItemFlag(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem> {
    assertCanReviewLineItems(request.roles);

    return this.expenseReportRepository.clearLineItemFlag(request);
  }

  public async updateLineItemDeductible(
    request: UpdateLineItemDeductibleServiceRequest
  ): Promise<ApprovalQueueLineItem> {
    assertCanReviewLineItems(request.roles);

    return this.expenseReportRepository.updateLineItemDeductible(request);
  }

  public async submit(request: SubmitExpenseReportRequest): Promise<ExpenseReportResponse> {
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

    assertGlCodingCategoriesAreSupported(report);
    const glCodingRequest = toGlCodingRequest(report);
    const glCodingResponse = await this.glCodingEngineClient.codeExpenseReport(
      glCodingRequest,
      request.bearerToken
    );
    const codedLineItems = readCodedLineItems(glCodingResponse, glCodingRequest);
    const submittedReport = await this.expenseReportRepository.submitForApReview({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      flaggedLineItemIds: codedLineItems.filter((item) => item.flagged).map((item) => item.id),
      codedLineItems
    });

    return submittedReport;
  }

  public async submitForApReview(
    request: SubmitExpenseReportRequest
  ): Promise<ExpenseReportResponse> {
    return this.submit(request);
  }

  public async advance(request: TransitionExpenseReportRequest): Promise<ExpenseReportResponse> {
    const report = await this.expenseReportRepository.findForSubmit(
      request.expenseReportId,
      request.tenantId
    );

    if (report === null) {
      throw new NotFoundError("Expense Report not found.");
    }

    if (!canReview(request.roles)) {
      await this.expenseReportRepository.recordDeniedTransition({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        action: "Expense Report Transition Denied",
        reason: "Actor is not permitted to transition Expense Reports."
      });
      throw new ForbiddenError("Employee cannot transition Expense Reports.");
    }

    if (report.currentStage === "Manager Approval" && hasUnclearedFlag(report)) {
      await this.expenseReportRepository.recordDeniedTransition({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        action: "Expense Report Transition Denied",
        reason: "Over-500 line items must be cleared before AP Review."
      });
      throw new ConflictError("Over-500 line items must be cleared before AP Review.");
    }

    const toStage = nextStage(report.currentStage);
    return this.expenseReportRepository.transitionStage({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      fromStage: report.currentStage,
      toStage,
      reason: request.reason ?? `Expense Report advanced to ${toStage}.`
    });
  }

  public async reject(request: RejectExpenseReportRequest): Promise<ExpenseReportResponse> {
    const report = await this.expenseReportRepository.findForSubmit(
      request.expenseReportId,
      request.tenantId
    );

    if (report === null) {
      throw new NotFoundError("Expense Report not found.");
    }

    if (!canReview(request.roles)) {
      await this.expenseReportRepository.recordDeniedTransition({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        action: "Expense Report Send Back Denied",
        reason: "Actor is not permitted to send back Expense Reports."
      });
      throw new ForbiddenError("Employee cannot transition Expense Reports.");
    }

    if (report.currentStage !== "Manager Approval" && report.currentStage !== "AP Review") {
      throw new ConflictError(
        "Expense Report can only be rejected from Manager Approval or AP Review."
      );
    }

    return this.expenseReportRepository.transitionStage({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      fromStage: report.currentStage,
      toStage: "Drafted",
      reason: request.reason,
      action: "Expense Report Sent Back"
    });
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository(),
  glCodingEngineClient: GlCodingEngineClient = createGlCodingEngineClient()
): ExpenseReportService {
  return new RepositoryExpenseReportService(expenseReportRepository, glCodingEngineClient);
}

const supportedGlCodingCategories = new Set(["Meals", "Lodging", "Mileage", "Supplies", "Other"]);

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

function assertGlCodingCategoriesAreSupported(report: ExpenseReportForSubmit): void {
  const unsupportedCategory = report.lineItems.find(
    (item) => !supportedGlCodingCategories.has(item.category)
  )?.category;

  if (unsupportedCategory !== undefined) {
    throw new ConflictError(
      `Expense Report contains unsupported category: ${unsupportedCategory}.`
    );
  }
}

function readCodedLineItems(
  response: unknown,
  request: ReturnType<typeof toGlCodingRequest>
): {
  id: string;
  status: "mapped" | "unmapped";
  flagged: boolean;
  glCodeId: string | null;
  accountCode: string | null;
  accountName: string | null;
  normalBalance: "debit" | "credit" | null;
  unmappedMarker: string | null;
}[] {
  if (!isRecord(response) || !Array.isArray(response.coded_line_items)) {
    return [];
  }

  const requestLineItemIds = new Set(request.line_items.map((item) => item.line_item_id));
  return response.coded_line_items.map((item) => {
    if (!isCodedLineItem(item)) {
      throw new BoundaryContractError("GL coding response included an invalid line item.");
    }

    if (!requestLineItemIds.has(item.line_item_id)) {
      throw new BoundaryContractError("GL coding response included an unknown line item ID.");
    }

    if (item.status === "mapped") {
      return {
        id: item.line_item_id,
        status: item.status,
        flagged: item.flagged,
        glCodeId: item.gl_code_id,
        accountCode: item.account_code,
        accountName: item.account_name,
        normalBalance: item.normal_balance,
        unmappedMarker: null
      };
    }

    return {
      id: item.line_item_id,
      status: item.status,
      flagged: item.flagged,
      glCodeId: null,
      accountCode: null,
      accountName: null,
      normalBalance: null,
      unmappedMarker: item.unmapped_marker
    };
  });
}

type CodedLineItemFromEngine =
  | {
      line_item_id: string;
      status: "mapped";
      flagged: boolean;
      gl_code_id: string;
      account_code: string;
      account_name: string;
      normal_balance: "debit" | "credit";
    }
  | {
      line_item_id: string;
      status: "unmapped";
      flagged: boolean;
      unmapped_marker: "UNMAPPED_GL_CATEGORY";
    };

function isCodedLineItem(value: unknown): value is CodedLineItemFromEngine {
  if (!isRecord(value) || typeof value.line_item_id !== "string") {
    return false;
  }

  if (value.status === "mapped") {
    return (
      typeof value.flagged === "boolean" &&
      typeof value.gl_code_id === "string" &&
      typeof value.account_code === "string" &&
      typeof value.account_name === "string" &&
      (value.normal_balance === "debit" || value.normal_balance === "credit")
    );
  }

  return (
    value.status === "unmapped" &&
    typeof value.flagged === "boolean" &&
    value.unmapped_marker === "UNMAPPED_GL_CATEGORY"
  );
}

function canReview(roles: string[]): boolean {
  return (
    roles.includes("Department Manager") ||
    roles.includes("Finance Admin") ||
    roles.includes("Platform Admin") ||
    roles.includes("ExpenseFlow Platform Admin")
  );
}

function assertCanReviewLineItems(roles: string[]): void {
  if (!canReview(roles)) {
    throw new ForbiddenError("Employee cannot review Expense Report line items.");
  }
}

function hasUnclearedFlag(report: ExpenseReportForSubmit): boolean {
  return report.lineItems.some((item) => item.flagged && !item.flag_cleared);
}

function nextStage(
  stage: ExpenseReportResponse["currentStage"]
): ExpenseReportResponse["currentStage"] {
  if (stage === "Submitted") {
    return "Manager Approval";
  }

  if (stage === "Manager Approval") {
    return "AP Review";
  }

  if (stage === "AP Review") {
    return "Paid";
  }

  throw new ConflictError(`Expense Report cannot advance from ${stage}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
