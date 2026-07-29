import { NextFunction } from "express";

import { RequestWithAuthContext, requireAuthenticatedContext } from "../auth/verifier.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/problem-json.js";
import {
  approvalQueueLineItemSchema,
  approvalQueueResponseSchema,
  caseQueueRollupResponseSchema,
  caseQueueResponseSchema,
  createExpenseReportRequestSchema,
  deductibleRequestSchema,
  expenseReportIdParamSchema,
  expenseReportResponseSchema,
  lineItemIdParamSchema,
  rejectExpenseReportRequestSchema,
  transitionRequestSchema
} from "../schemas/expense-report.schema.js";
import {
  ExpenseReportService,
  createExpenseReportService
} from "../services/expense-report-service.js";

interface JsonResponse {
  status(code: number): {
    json(body: unknown): void;
  };
}

export class ExpenseReportController {
  public constructor(
    private readonly expenseReportService: ExpenseReportService = createExpenseReportService()
  ) {}

  public createExpenseReport = async (
    request: Pick<RequestWithAuthContext, "authContext" | "body">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedRequest = createExpenseReportRequestSchema.parse(request.body);
    const authContext = requireAuthenticatedContext(request);
    const report = await this.expenseReportService.createDraftReport({
      ...parsedRequest,
      tenantId: authContext.tenantId,
      submitterId: authContext.userId
    });
    const parsedResponse = expenseReportResponseSchema.parse(report);

    response.status(201).json(parsedResponse);
  };

  public readExpenseReport = async (
    request: Pick<RequestWithAuthContext, "authContext" | "params">,
    response: JsonResponse,
    next: NextFunction
  ): Promise<void> => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const authContext = requireAuthenticatedContext(request);
    const report = await this.expenseReportService.findReport(
      parsedParams.id,
      authContext.tenantId
    );

    if (report === null) {
      next(new NotFoundError("Expense Report not found."));
      return;
    }

    const parsedResponse = expenseReportResponseSchema.parse(report);

    response.status(200).json(parsedResponse);
  };

  public readCaseQueue = async (
    request: Pick<RequestWithAuthContext, "authContext">,
    response: JsonResponse
  ): Promise<void> => {
    const authContext = requireAuthenticatedContext(request);
    if (!canReadCaseQueue(authContext.roles)) {
      throw new ForbiddenError("Employee cannot read the Case Queue.");
    }

    const cases = await this.expenseReportService.listCaseQueue(authContext.tenantId);
    const parsedResponse = caseQueueResponseSchema.parse({ cases });

    response.status(200).json(parsedResponse);
  };

  public readCaseQueueRollup = async (
    request: Pick<RequestWithAuthContext, "authContext">,
    response: JsonResponse
  ): Promise<void> => {
    const authContext = requireAuthenticatedContext(request);
    const summaries = await this.expenseReportService.listCaseQueueRollup({
      tenantId: authContext.tenantId,
      roles: authContext.roles
    });
    const parsedResponse = caseQueueRollupResponseSchema.parse({ summaries });

    response.status(200).json(parsedResponse);
  };

  public readApprovalQueueLineItems = async (
    request: Pick<RequestWithAuthContext, "authContext">,
    response: JsonResponse
  ): Promise<void> => {
    const authContext = requireAuthenticatedContext(request);
    const lineItems = await this.expenseReportService.listApprovalQueueLineItems({
      tenantId: authContext.tenantId,
      roles: authContext.roles
    });
    const parsedResponse = approvalQueueResponseSchema.parse({ lineItems });

    response.status(200).json(parsedResponse);
  };

  public approveLineItem = async (
    request: Pick<RequestWithAuthContext, "authContext" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = lineItemIdParamSchema.parse(request.params);
    const authContext = requireAuthenticatedContext(request);
    const lineItem = await this.expenseReportService.approveLineItem({
      expenseReportId: parsedParams.id,
      lineItemId: parsedParams.lineItemId,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles
    });
    const parsedResponse = approvalQueueLineItemSchema.parse(lineItem);

    response.status(200).json(parsedResponse);
  };

  public rejectLineItem = async (
    request: Pick<RequestWithAuthContext, "authContext" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = lineItemIdParamSchema.parse(request.params);
    const authContext = requireAuthenticatedContext(request);
    const lineItem = await this.expenseReportService.rejectLineItem({
      expenseReportId: parsedParams.id,
      lineItemId: parsedParams.lineItemId,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles
    });
    const parsedResponse = approvalQueueLineItemSchema.parse(lineItem);

    response.status(200).json(parsedResponse);
  };

  public clearLineItemFlag = async (
    request: Pick<RequestWithAuthContext, "authContext" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = lineItemIdParamSchema.parse(request.params);
    const authContext = requireAuthenticatedContext(request);
    const lineItem = await this.expenseReportService.clearLineItemFlag({
      expenseReportId: parsedParams.id,
      lineItemId: parsedParams.lineItemId,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles
    });
    const parsedResponse = approvalQueueLineItemSchema.parse(lineItem);

    response.status(200).json(parsedResponse);
  };

  public updateLineItemDeductible = async (
    request: Pick<RequestWithAuthContext, "authContext" | "body" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = lineItemIdParamSchema.parse(request.params);
    const parsedBody = deductibleRequestSchema.parse(request.body);
    const authContext = requireAuthenticatedContext(request);
    const lineItem = await this.expenseReportService.updateLineItemDeductible({
      expenseReportId: parsedParams.id,
      lineItemId: parsedParams.lineItemId,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles,
      deductible: parsedBody.deductible
    });
    const parsedResponse = approvalQueueLineItemSchema.parse(lineItem);

    response.status(200).json(parsedResponse);
  };

  public submitExpenseReport = async (
    request: Pick<RequestWithAuthContext, "authContext" | "headers" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const authContext = requireAuthenticatedContext(request);
    const submittedReport = await this.expenseReportService.submit({
      expenseReportId: parsedParams.id,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      bearerToken: readBearerToken(request.headers.authorization)
    });
    const parsedResponse = expenseReportResponseSchema.parse(submittedReport);

    response.status(200).json(parsedResponse);
  };

  public advanceExpenseReport = async (
    request: Pick<RequestWithAuthContext, "authContext" | "body" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const parsedBody = transitionRequestSchema.parse(request.body);
    const authContext = requireAuthenticatedContext(request);
    const advancedReport = await this.expenseReportService.advance({
      expenseReportId: parsedParams.id,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles,
      reason: parsedBody.reason
    });
    const parsedResponse = expenseReportResponseSchema.parse(advancedReport);

    response.status(200).json(parsedResponse);
  };

  public rejectExpenseReport = async (
    request: Pick<RequestWithAuthContext, "authContext" | "body" | "params">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const parsedBody = rejectExpenseReportRequestSchema.parse(request.body);
    const authContext = requireAuthenticatedContext(request);
    const rejectedReport = await this.expenseReportService.reject({
      expenseReportId: parsedParams.id,
      tenantId: authContext.tenantId,
      actorId: authContext.userId,
      roles: authContext.roles,
      reason: parsedBody.reason
    });
    const parsedResponse = expenseReportResponseSchema.parse(rejectedReport);

    response.status(200).json(parsedResponse);
  };
}

export function createExpenseReportController(): ExpenseReportController {
  return new ExpenseReportController();
}

function readBearerToken(authorizationHeader: string | string[] | undefined): string {
  if (typeof authorizationHeader !== "string") {
    throw new UnauthorizedError("Missing or invalid bearer token.");
  }

  const match = authorizationHeader.match(/^Bearer (?<token>.+)$/i);
  if (match?.groups?.token === undefined || match.groups.token.trim() === "") {
    throw new UnauthorizedError("Missing or invalid bearer token.");
  }

  return match.groups.token;
}

function canReadCaseQueue(roles: readonly string[]): boolean {
  return (
    roles.includes("Department Manager") ||
    roles.includes("Finance Admin") ||
    roles.includes("Platform Admin") ||
    roles.includes("ExpenseFlow Platform Admin")
  );
}
