import { describe, expect, it } from "vitest";

import {
  createExpenseDraftExpenseReportRequestSchema,
  createExpenseReportRequestSchema,
  createMileageDraftExpenseReportRequestSchema
} from "./expense-report-write.schema.js";

describe("Expense Report write shared schema", () => {
  it("accepts valid synthetic mileage and expense draft payloads", () => {
    expect(
      createMileageDraftExpenseReportRequestSchema.parse({
        draftType: "mileage",
        dueDate: "2026-08-03",
        mileageEntries: [
          {
            business_purpose: "Synthetic client support visit.",
            destination: "Synthetic Destination Office",
            miles: "18.25",
            origin: "Synthetic Origin Office",
            trip_date: "2026-08-01"
          }
        ],
        priority: "Normal"
      })
    ).toMatchObject({
      draftType: "mileage",
      mileageEntries: [
        {
          miles: 18.25
        }
      ]
    });

    expect(
      createExpenseDraftExpenseReportRequestSchema.parse({
        draftType: "expense",
        dueDate: "2026-08-04",
        lineItems: [
          {
            amount_cents: "4250",
            category: "Meals",
            currency: "USD",
            merchant: "Synthetic Cafe",
            receipt: {
              amount_cents: "4250",
              currency: "USD",
              merchant: "Synthetic Cafe",
              receipt_date: "2026-08-02",
              receipt_number: "SYN-4250"
            }
          }
        ],
        priority: "High"
      })
    ).toMatchObject({
      draftType: "expense",
      lineItems: [
        {
          amount_cents: 4250,
          receipt: {
            amount_cents: 4250
          }
        }
      ]
    });
  });

  it("rejects malformed mileage draft payloads", () => {
    expect(
      createExpenseReportRequestSchema.safeParse({
        draftType: "mileage",
        mileageEntries: [
          {
            business_purpose: "Synthetic client support visit.",
            destination: "Synthetic Destination Office",
            miles: 0,
            origin: "Synthetic Origin Office",
            trip_date: "08/01/2026"
          }
        ],
        priority: "Normal"
      }).success
    ).toBe(false);
  });

  it("rejects malformed expense draft payloads", () => {
    expect(
      createExpenseReportRequestSchema.safeParse({
        draftType: "expense",
        lineItems: [
          {
            amount_cents: -1,
            category: "",
            currency: "usd",
            merchant: "Synthetic Cafe"
          }
        ],
        priority: "Normal"
      }).success
    ).toBe(false);
  });

  it("rejects client-owned server fields", () => {
    expect(
      createExpenseReportRequestSchema.safeParse({
        currentStage: "Submitted",
        draftType: "mileage",
        mileageEntries: [
          {
            business_purpose: "Synthetic client support visit.",
            destination: "Synthetic Destination Office",
            miles: 18.25,
            origin: "Synthetic Origin Office",
            trip_date: "2026-08-01"
          }
        ],
        priority: "Normal",
        submitterId: "synthetic-user-00000000-0000-4000-8000-000000000001",
        tenantId: "00000000-0000-4000-8000-000000000002"
      }).success
    ).toBe(false);
  });
});
