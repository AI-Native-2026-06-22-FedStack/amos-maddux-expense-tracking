import { NextFunction, Request } from "express";

import { NotFoundError } from "../errors/problem-json.js";
import {
  createExpenseReportRequestSchema,
  expenseReportIdParamSchema,
  expenseReportReadQuerySchema,
  expenseReportResponseSchema
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
    request: Pick<Request, "body">,
    response: JsonResponse
  ): Promise<void> => {
    const parsedRequest = createExpenseReportRequestSchema.parse(request.body);
    const report = await this.expenseReportService.createDraftReport(parsedRequest);
    const parsedResponse = expenseReportResponseSchema.parse(report);

    response.status(201).json(parsedResponse);
  };

  public readExpenseReport = async (
    request: Pick<Request, "params" | "query">,
    response: JsonResponse,
    next: NextFunction
  ): Promise<void> => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const parsedQuery = expenseReportReadQuerySchema.parse(request.query);
    const report = await this.expenseReportService.findReport(
      parsedParams.id,
      parsedQuery.tenantId
    );

    if (report === null) {
      next(new NotFoundError("Expense Report not found."));
      return;
    }

    const parsedResponse = expenseReportResponseSchema.parse(report);

    response.status(200).json(parsedResponse);
  };
}

export function createExpenseReportController(): ExpenseReportController {
  return new ExpenseReportController();
}
