import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { expenseReport, expenseReportPriorities, expenseReportStages } from "../db/schema.js";

export const expenseReportStageSchema = z.enum(expenseReportStages);

export const expenseReportPrioritySchema = z.enum(expenseReportPriorities);

// The API omits id because the server/database generates it for new Expense Reports.
export const createExpenseReportRequestSchema = createInsertSchema(expenseReport).omit({
  id: true
});

export const expenseReportIdParamSchema = z.object({
  id: z.uuid()
});

export const expenseReportReadQuerySchema = z.object({
  tenantId: z.uuid()
});

export const expenseReportResponseSchema = createSelectSchema(expenseReport);

export type CreateExpenseReportRequest = z.infer<typeof createExpenseReportRequestSchema>;
export type ExpenseReportIdParam = z.infer<typeof expenseReportIdParamSchema>;
export type ExpenseReportReadQuery = z.infer<typeof expenseReportReadQuerySchema>;
export type ExpenseReportResponse = z.infer<typeof expenseReportResponseSchema>;
export type ExpenseReportStage = z.infer<typeof expenseReportStageSchema>;
export type ExpenseReportPriority = z.infer<typeof expenseReportPrioritySchema>;
