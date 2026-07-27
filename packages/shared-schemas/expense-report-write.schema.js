import { z } from "zod";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Use YYYY-MM-DD.");
const optionalDateOnlySchema = z
  .union([dateOnlySchema, z.literal("")])
  .optional()
  .transform((value) => (value === "" ? undefined : value));
const textSchema = (label, max) => z.string().trim().min(1, `${label} is required.`).max(max);

const prioritySchema = z.enum(["Low", "Normal", "High", "Urgent"]);
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/u, "Use a three-letter uppercase currency code.");

export const mileageEntryDraftSchema = z.object({
  business_purpose: textSchema("Business purpose", 500),
  destination: textSchema("Destination", 200),
  miles: z.coerce.number().positive("Miles must be greater than 0."),
  origin: textSchema("Origin", 200),
  trip_date: dateOnlySchema
});

export const expenseLineItemDraftSchema = z.object({
  amount_cents: z.coerce
    .number()
    .int("Amount must be whole cents.")
    .positive("Amount must be greater than 0."),
  category: textSchema("Category", 100),
  currency: currencySchema,
  merchant: textSchema("Merchant", 200),
  receipt: z.object({
    amount_cents: z.coerce
      .number()
      .int("Receipt amount must be whole cents.")
      .positive("Receipt amount must be greater than 0."),
    currency: currencySchema,
    merchant: textSchema("Receipt merchant", 200),
    receipt_date: dateOnlySchema,
    receipt_number: textSchema("Receipt number", 100).optional()
  })
});

export const createMileageDraftExpenseReportRequestSchema = z
  .object({
    dueDate: optionalDateOnlySchema,
    draftType: z.literal("mileage"),
    mileageEntries: z.array(mileageEntryDraftSchema).min(1, "Add at least one mileage entry."),
    priority: prioritySchema.default("Normal")
  })
  .strict();

export const createExpenseDraftExpenseReportRequestSchema = z
  .object({
    dueDate: optionalDateOnlySchema,
    draftType: z.literal("expense"),
    lineItems: z.array(expenseLineItemDraftSchema).min(1, "Add at least one line item."),
    priority: prioritySchema.default("Normal")
  })
  .strict();

export const createExpenseReportRequestSchema = z.discriminatedUnion("draftType", [
  createMileageDraftExpenseReportRequestSchema,
  createExpenseDraftExpenseReportRequestSchema
]);
