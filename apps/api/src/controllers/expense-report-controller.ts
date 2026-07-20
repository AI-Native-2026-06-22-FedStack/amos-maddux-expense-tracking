import { NextFunction } from "express";

import { RequestWithAuthContext, requireAuthenticatedContext } from "../auth/verifier.js";
import { NotFoundError, UnauthorizedError } from "../errors/problem-json.js";
import {
  createExpenseReportRequestSchema,
  expenseReportIdParamSchema,
  expenseReportResponseSchema,
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
