import { z } from "zod";

import { expenseReportStageSchema } from "../schemas/expense-report.schema.js";

export const EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE =
  "com.expenseflow.expense-report.stage-transitioned.v1";
export const EXPENSE_REPORT_STAGE_TRANSITIONED_SCHEMA_VERSION = "1.0.0";
export const EXPENSE_REPORT_STAGE_TRANSITIONED_SOURCE = "/expenseflow/apps/api/expense-reports";

export const expenseReportStageTransitionedDataSchema = z
  .object({
    schemaVersion: z.literal(EXPENSE_REPORT_STAGE_TRANSITIONED_SCHEMA_VERSION),
    tenantId: z.uuid(),
    expenseReportId: z.uuid(),
    fromStage: expenseReportStageSchema,
    toStage: expenseReportStageSchema,
    correlationId: z.string().min(1)
  })
  .strict();

export const expenseReportStageTransitionedEventSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    specversion: z.literal("1.0"),
    type: z.literal(EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE),
    time: z.iso.datetime().optional(),
    subject: z
      .string()
      .regex(/^ExpenseReport\/[0-9a-fA-F-]+$/)
      .optional(),
    datacontenttype: z.literal("application/json").optional(),
    data: expenseReportStageTransitionedDataSchema
  })
  .strict();

export type ExpenseReportStageTransitionedData = z.infer<
  typeof expenseReportStageTransitionedDataSchema
>;
export type ExpenseReportStageTransitionedEvent = z.infer<
  typeof expenseReportStageTransitionedEventSchema
>;

export interface BuildExpenseReportStageTransitionedEventRequest {
  id: string;
  time: string;
  tenantId: string;
  expenseReportId: string;
  fromStage: z.infer<typeof expenseReportStageSchema>;
  toStage: z.infer<typeof expenseReportStageSchema>;
  correlationId: string;
}

export function buildExpenseReportStageTransitionedEvent(
  request: BuildExpenseReportStageTransitionedEventRequest
): ExpenseReportStageTransitionedEvent {
  return expenseReportStageTransitionedEventSchema.parse({
    id: request.id,
    source: EXPENSE_REPORT_STAGE_TRANSITIONED_SOURCE,
    specversion: "1.0",
    type: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
    time: request.time,
    subject: `ExpenseReport/${request.expenseReportId}`,
    datacontenttype: "application/json",
    data: {
      schemaVersion: EXPENSE_REPORT_STAGE_TRANSITIONED_SCHEMA_VERSION,
      tenantId: request.tenantId,
      expenseReportId: request.expenseReportId,
      fromStage: request.fromStage,
      toStage: request.toStage,
      correlationId: request.correlationId
    }
  });
}
