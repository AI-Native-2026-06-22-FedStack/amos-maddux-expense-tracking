import { z } from "zod";

export const expenseReportStageSchema = z.enum([
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
]);

export const expenseReportPrioritySchema = z.enum(["Low", "Normal", "High", "Urgent"]);

export const createExpenseReportRequestSchema = z.object({
  tenantId: z.uuid(),
  submitterId: z.string().trim().min(1)
});

export const expenseReportIdParamSchema = z.object({
  id: z.uuid()
});

export const expenseReportResponseSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  submitterId: z.string().min(1),
  stage: expenseReportStageSchema,
  priority: expenseReportPrioritySchema,
  dueDate: z.iso.date().nullable(),
  onHold: z.boolean(),
  holdReason: z.string().min(1).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export type CreateExpenseReportRequest = z.infer<typeof createExpenseReportRequestSchema>;
export type ExpenseReportIdParam = z.infer<typeof expenseReportIdParamSchema>;
export type ExpenseReportResponse = z.infer<typeof expenseReportResponseSchema>;
export type ExpenseReportStage = z.infer<typeof expenseReportStageSchema>;
export type ExpenseReportPriority = z.infer<typeof expenseReportPrioritySchema>;
