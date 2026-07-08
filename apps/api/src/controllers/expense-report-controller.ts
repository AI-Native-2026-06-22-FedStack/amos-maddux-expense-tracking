import { NextFunction, Request } from "express";

import { NotFoundError } from "../errors/problem-json.js";
import {
  createExpenseReportRequestSchema,
  expenseReportIdParamSchema,
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

  public createExpenseReport = (request: Pick<Request, "body">, response: JsonResponse): void => {
    const parsedRequest = createExpenseReportRequestSchema.parse(request.body);
    const report = this.expenseReportService.createDraftReport(parsedRequest);
    const parsedResponse = expenseReportResponseSchema.parse(report);

    response.status(201).json(parsedResponse);
  };

  public readExpenseReport = (
    request: Pick<Request, "params">,
    response: JsonResponse,
    next: NextFunction
  ): void => {
    const parsedParams = expenseReportIdParamSchema.parse(request.params);
    const report = this.expenseReportService.findReport(parsedParams.id);

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
