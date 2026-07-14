import { RequestHandler, Router } from "express";

import { requireJwtAuthentication } from "../auth/verifier.js";
import { createExpenseReportController } from "../controllers/expense-report-controller.js";

interface CreateExpenseReportRouterOptions {
  expenseWriteRateLimiters?: readonly RequestHandler[];
}

export function createExpenseReportRouter(options: CreateExpenseReportRouterOptions = {}): Router {
  const router = Router();
  const expenseReportController = createExpenseReportController();
  const expenseWriteRateLimiters = options.expenseWriteRateLimiters ?? [];

  router.post(
    "/expense-reports",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    expenseReportController.createExpenseReport
  );
  router.get(
    "/expense-reports/:id",
    requireJwtAuthentication,
    expenseReportController.readExpenseReport
  );

  return router;
}
