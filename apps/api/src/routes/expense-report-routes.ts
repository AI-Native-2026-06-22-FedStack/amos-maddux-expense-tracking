import { RequestHandler, Router } from "express";

import { requireJwtAuthentication } from "../auth/verifier.js";
import { createExpenseReportController } from "../controllers/expense-report-controller.js";

interface CreateExpenseReportRouterOptions {
  expenseWriteRateLimiters?: readonly RequestHandler[];
  expenseReportIdempotencyMiddleware?: RequestHandler;
}

export function createExpenseReportRouter(options: CreateExpenseReportRouterOptions = {}): Router {
  const router = Router();
  const expenseReportController = createExpenseReportController();
  const expenseWriteRateLimiters = options.expenseWriteRateLimiters ?? [];
  const expenseReportIdempotencyMiddlewares =
    options.expenseReportIdempotencyMiddleware === undefined
      ? []
      : [options.expenseReportIdempotencyMiddleware];

  router.post(
    "/expense-reports",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.createExpenseReport
  );
  router.get(
    "/expense-reports/:id",
    requireJwtAuthentication,
    expenseReportController.readExpenseReport
  );

  return router;
}
