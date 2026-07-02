import { Router } from "express";

import { createExpenseReportController } from "../controllers/expense-report-controller.js";

export function createExpenseReportRouter(): Router {
  const router = Router();
  const expenseReportController = createExpenseReportController();

  router.post("/expense-reports", expenseReportController.createExpenseReport);
  router.get("/expense-reports/:id", expenseReportController.readExpenseReport);

  return router;
}
