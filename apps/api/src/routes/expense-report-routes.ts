import { RequestHandler, Router } from "express";

import { requireJwtAuthentication } from "../auth/verifier.js";
import {
  ExpenseReportController,
  createExpenseReportController
} from "../controllers/expense-report-controller.js";

interface CreateExpenseReportRouterOptions {
  expenseWriteRateLimiters?: readonly RequestHandler[];
  expenseReportIdempotencyMiddleware?: RequestHandler;
  expenseReportController?: ExpenseReportController;
}

export function createExpenseReportRouter(options: CreateExpenseReportRouterOptions = {}): Router {
  const router = Router();
  const expenseReportController =
    options.expenseReportController ?? createExpenseReportController();
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
    "/expense-reports/case-queue",
    requireJwtAuthentication,
    expenseReportController.readCaseQueue
  );
  router.get(
    "/expense-reports/approval-line-items",
    requireJwtAuthentication,
    expenseReportController.readApprovalQueueLineItems
  );
  router.get(
    "/expense-reports/:id",
    requireJwtAuthentication,
    expenseReportController.readExpenseReport
  );
  router.post(
    "/expense-reports/:id/line-items/:lineItemId/approve",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.approveLineItem
  );
  router.post(
    "/expense-reports/:id/line-items/:lineItemId/reject",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.rejectLineItem
  );
  router.post(
    "/expense-reports/:id/line-items/:lineItemId/clear-flag",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.clearLineItemFlag
  );
  router.patch(
    "/expense-reports/:id/line-items/:lineItemId/deductible",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.updateLineItemDeductible
  );
  router.post(
    "/expense-reports/:id/submit",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.submitExpenseReport
  );
  router.post(
    "/expense-reports/:id/advance",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.advanceExpenseReport
  );
  router.post(
    "/expense-reports/:id/reject",
    requireJwtAuthentication,
    ...expenseWriteRateLimiters,
    ...expenseReportIdempotencyMiddlewares,
    expenseReportController.rejectExpenseReport
  );

  return router;
}
