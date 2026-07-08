import { Router } from "express";

import { requireJwtAuthentication } from "../auth/verifier.js";
import { createExpenseReportController } from "../controllers/expense-report-controller.js";

export function createExpenseReportRouter(): Router {
  const router = Router();
  const expenseReportController = createExpenseReportController();

  router.post(
    "/expense-reports",
    requireJwtAuthentication,
    expenseReportController.createExpenseReport
  );
  router.get("/expense-reports/:id", expenseReportController.readExpenseReport);

  return router;
}
