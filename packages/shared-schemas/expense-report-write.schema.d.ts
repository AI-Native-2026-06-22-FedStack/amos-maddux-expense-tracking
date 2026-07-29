import { z } from "zod";

export type ExpenseReportPriority = "Low" | "Normal" | "High" | "Urgent";

export interface MileageEntryDraft {
  business_purpose: string;
  destination: string;
  miles: number;
  origin: string;
  trip_date: string;
}

export interface ExpenseLineItemReceiptDraft {
  amount_cents: number;
  currency: string;
  merchant: string;
  receipt_date: string;
  receipt_number?: string;
}

export interface ExpenseLineItemDraft {
  amount_cents: number;
  category: string;
  currency: string;
  merchant: string;
  receipt: ExpenseLineItemReceiptDraft;
}

export interface CreateMileageDraftExpenseReportRequest {
  draftType: "mileage";
  dueDate?: string;
  mileageEntries: MileageEntryDraft[];
  priority: ExpenseReportPriority;
}

export interface CreateExpenseDraftExpenseReportRequest {
  draftType: "expense";
  dueDate?: string;
  lineItems: ExpenseLineItemDraft[];
  priority: ExpenseReportPriority;
}

export type CreateExpenseReportRequest =
  | CreateMileageDraftExpenseReportRequest
  | CreateExpenseDraftExpenseReportRequest;

export declare const mileageEntryDraftSchema: z.ZodType<MileageEntryDraft, MileageEntryDraft>;
export declare const expenseLineItemDraftSchema: z.ZodType<ExpenseLineItemDraft, ExpenseLineItemDraft>;
export declare const createMileageDraftExpenseReportRequestSchema: z.ZodType<
  CreateMileageDraftExpenseReportRequest,
  CreateMileageDraftExpenseReportRequest
>;
export declare const createExpenseDraftExpenseReportRequestSchema: z.ZodType<
  CreateExpenseDraftExpenseReportRequest,
  CreateExpenseDraftExpenseReportRequest
>;
export declare const createExpenseReportRequestSchema: z.ZodType<
  CreateExpenseReportRequest,
  CreateExpenseReportRequest
>;
