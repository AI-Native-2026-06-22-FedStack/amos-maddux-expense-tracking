import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import {
  createExpenseReportRequestSchema,
  createExpenseDraftExpenseReportRequestSchema,
  createMileageDraftExpenseReportRequestSchema,
  type CreateExpenseDraftExpenseReportRequest,
  type CreateMileageDraftExpenseReportRequest,
  type CreateExpenseReportRequest
} from "@expenseflow/shared-schemas";

import {
  expenseReport,
  expenseReportPriorities,
  expenseReportStages,
  managerReviewStatuses
} from "../db/schema.js";

export const expenseReportStageSchema = z.enum(expenseReportStages);

export const expenseReportPrioritySchema = z.enum(expenseReportPriorities);
export const managerReviewStatusSchema = z.enum(managerReviewStatuses);

export { createExpenseReportRequestSchema };
export { createExpenseDraftExpenseReportRequestSchema, createMileageDraftExpenseReportRequestSchema };

export const expenseReportIdParamSchema = z.object({
  id: z.uuid()
});

export const transitionRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional()
});

export const rejectExpenseReportRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500)
});
export const lineItemIdParamSchema = expenseReportIdParamSchema.extend({
  lineItemId: z.uuid()
});
export const deductibleRequestSchema = z.object({
  deductible: z.boolean()
});

export const expenseReportResponseSchema = createSelectSchema(expenseReport).strict();
export const caseQueueItemSchema = expenseReportResponseSchema.pick({
  id: true,
  currentStage: true,
  priority: true,
  dueDate: true,
  onHold: true,
  updatedAt: true
});
export const caseQueueResponseSchema = z.object({
  cases: z.array(caseQueueItemSchema)
});
export const approvalQueueLineItemSchema = z.object({
  reportId: z.uuid(),
  reportStage: expenseReportStageSchema,
  lineItemId: z.uuid(),
  merchant: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  category: z.string(),
  flagged: z.boolean(),
  flagCleared: z.boolean(),
  glCodingStatus: z.enum(["mapped", "unmapped"]).nullable(),
  glCodeId: z.uuid().nullable(),
  glAccountCode: z.string().nullable(),
  glAccountName: z.string().nullable(),
  deductible: z.boolean(),
  managerReviewStatus: managerReviewStatusSchema,
  createdAt: z.date()
});
export const approvalQueueResponseSchema = z.object({
  lineItems: z.array(approvalQueueLineItemSchema)
});

export type { CreateExpenseReportRequest };
export type { CreateExpenseDraftExpenseReportRequest, CreateMileageDraftExpenseReportRequest };
export type CaseQueueItem = z.infer<typeof caseQueueItemSchema>;
export type CaseQueueResponse = z.infer<typeof caseQueueResponseSchema>;
export type ApprovalQueueLineItem = z.infer<typeof approvalQueueLineItemSchema>;
export type ApprovalQueueResponse = z.infer<typeof approvalQueueResponseSchema>;
export type ExpenseReportIdParam = z.infer<typeof expenseReportIdParamSchema>;
export type LineItemIdParam = z.infer<typeof lineItemIdParamSchema>;
export type ExpenseReportResponse = z.infer<typeof expenseReportResponseSchema>;
export type ExpenseReportStage = z.infer<typeof expenseReportStageSchema>;
export type ExpenseReportPriority = z.infer<typeof expenseReportPrioritySchema>;
export type TransitionRequest = z.infer<typeof transitionRequestSchema>;
export type RejectExpenseReportRequest = z.infer<typeof rejectExpenseReportRequestSchema>;
export type DeductibleRequest = z.infer<typeof deductibleRequestSchema>;
