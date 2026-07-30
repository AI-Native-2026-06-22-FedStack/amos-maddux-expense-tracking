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
import { createSettlementSaga, type SettlementSaga } from "./settlement-saga.js";

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
  updateLineItemDeductible(
    request: UpdateLineItemDeductibleServiceRequest
  ): Promise<ApprovalQueueLineItem>;
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
  correlationId: string;
}

export interface TransitionExpenseReportRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  roles: string[];
  correlationId: string;
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
    private readonly glCodingEngineClient: GlCodingEngineClient,
    private readonly settlementSaga: SettlementSaga
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
    assertCanManagerReviewLineItems(request.roles);

    return this.expenseReportRepository.approveLineItem(request);
  }

  public async rejectLineItem(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem> {
    assertCanManagerReviewLineItems(request.roles);

    return this.expenseReportRepository.rejectLineItem(request);
  }

  public async clearLineItemFlag(request: LineItemReviewRequest): Promise<ApprovalQueueLineItem> {
    assertCanManagerReviewLineItems(request.roles);

    return this.expenseReportRepository.clearLineItemFlag(request);
  }

  public async updateLineItemDeductible(
    request: UpdateLineItemDeductibleServiceRequest
  ): Promise<ApprovalQueueLineItem> {
    assertCanApReviewLineItems(request.roles);

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
      correlationId: request.correlationId,
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

    const toStage = nextStage(report.currentStage);

    if (!canAdvanceExpenseReport(request.roles, report.currentStage, toStage)) {
      await this.expenseReportRepository.recordDeniedTransition({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        action: "Expense Report Transition Denied",
        reason: "Actor is not permitted to transition Expense Reports."
      });
      throw new ForbiddenError("Actor cannot transition Expense Reports for this stage.");
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

    if (report.currentStage === "Paid" && toStage === "Reconciled") {
      return this.settlementSaga.settle({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        correlationId: request.correlationId,
        reason: request.reason
      });
    }

    const advancedReport = await this.expenseReportRepository.transitionStage({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      fromStage: report.currentStage,
      toStage,
      correlationId: request.correlationId,
      reason: request.reason ?? `Expense Report advanced to ${toStage}.`
    });

    return advancedReport;
  }

  public async reject(request: RejectExpenseReportRequest): Promise<ExpenseReportResponse> {
    const report = await this.expenseReportRepository.findForSubmit(
      request.expenseReportId,
      request.tenantId
    );

    if (report === null) {
      throw new NotFoundError("Expense Report not found.");
    }

    if (!canSendBackExpenseReport(request.roles)) {
      await this.expenseReportRepository.recordDeniedTransition({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        action: "Expense Report Send Back Denied",
        reason: "Actor is not permitted to send back Expense Reports."
      });
      throw new ForbiddenError("Actor cannot send Expense Reports back to Drafted.");
    }

    if (report.currentStage !== "Manager Approval" && report.currentStage !== "AP Review") {
      throw new ConflictError(
        "Expense Report can only be rejected from Manager Approval or AP Review."
      );
    }

    const rejectedReport = await this.expenseReportRepository.transitionStage({
      expenseReportId: request.expenseReportId,
      tenantId: request.tenantId,
      actorId: request.actorId,
      fromStage: report.currentStage,
      toStage: "Drafted",
      correlationId: request.correlationId,
      reason: request.reason,
      action: "Expense Report Sent Back"
    });

    return rejectedReport;
  }
}

export function createExpenseReportService(
  expenseReportRepository: ExpenseReportRepository = createExpenseReportRepository(),
  glCodingEngineClient: GlCodingEngineClient = createGlCodingEngineClient(),
  settlementSaga: SettlementSaga = createSettlementSaga(expenseReportRepository)
): ExpenseReportService {
  return new RepositoryExpenseReportService(
    expenseReportRepository,
    glCodingEngineClient,
    settlementSaga
  );
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
    throw new BoundaryContractError("GL coding response did not include coded line items.");
  }

  const requestLineItemIds = new Set(request.line_items.map((item) => item.line_item_id));
  const seenLineItemIds = new Set<string>();
  const codedLineItems = response.coded_line_items.map((item) => {
    if (!isCodedLineItem(item)) {
      throw new BoundaryContractError("GL coding response included an invalid line item.");
    }

    if (!requestLineItemIds.has(item.line_item_id)) {
      throw new BoundaryContractError("GL coding response included an unknown line item ID.");
    }

    if (seenLineItemIds.has(item.line_item_id)) {
      throw new BoundaryContractError("GL coding response included a duplicate line item ID.");
    }

    seenLineItemIds.add(item.line_item_id);

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

  if (seenLineItemIds.size !== requestLineItemIds.size) {
    throw new BoundaryContractError(
      "GL coding response did not include every requested line item."
    );
  }

  return codedLineItems;
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

function assertCanManagerReviewLineItems(roles: string[]): void {
  if (!hasDepartmentManagerRole(roles) && !hasPlatformAdminRole(roles)) {
    throw new ForbiddenError("Only Department Managers can review Manager Approval line items.");
  }
}

function assertCanApReviewLineItems(roles: string[]): void {
  if (!hasFinanceAdminRole(roles) && !hasPlatformAdminRole(roles)) {
    throw new ForbiddenError("Only Finance Admins can review AP Review line items.");
  }
}

function canAdvanceExpenseReport(
  roles: string[],
  fromStage: ExpenseReportResponse["currentStage"],
  toStage: ExpenseReportResponse["currentStage"]
): boolean {
  if (hasPlatformAdminRole(roles)) {
    return true;
  }

  if (hasDepartmentManagerRole(roles)) {
    return (
      (fromStage === "Submitted" && toStage === "Manager Approval") ||
      (fromStage === "Manager Approval" && toStage === "AP Review")
    );
  }

  return (
    hasFinanceAdminRole(roles) &&
    ((fromStage === "AP Review" && toStage === "Paid") ||
      (fromStage === "Paid" && toStage === "Reconciled"))
  );
}

function canSendBackExpenseReport(roles: string[]): boolean {
  return hasPlatformAdminRole(roles);
}

function hasDepartmentManagerRole(roles: string[]): boolean {
  return roles.includes("Department Manager");
}

function hasFinanceAdminRole(roles: string[]): boolean {
  return roles.includes("Finance Admin");
}

function hasPlatformAdminRole(roles: string[]): boolean {
  return roles.includes("Platform Admin") || roles.includes("ExpenseFlow Platform Admin");
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

  if (stage === "Paid") {
    return "Reconciled";
  }

  throw new ConflictError(`Expense Report cannot advance from ${stage}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
