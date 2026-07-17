import { describe, expect, it } from "vitest";

import {
  getGlCodingContractPackageName,
  validateGlCodingRequestPayload,
  validateGlCodingResponsePayload
} from "../src/services/gl-coding-contract.js";

describe("GL coding shared contract", () => {
  it("validates synthetic request and response payloads from the shared package schema", () => {
    expect(getGlCodingContractPackageName()).toBe("@expenseflow/shared-schemas");

    expect(() =>
      validateGlCodingRequestPayload({
        line_items: [
          {
            line_item_id: "00000000-0000-4000-8000-000000000101",
            amount: "42.50",
            currency: "USD",
            category: "Meals"
          }
        ],
        mileage_entries: [
          {
            mileage_entry_id: "00000000-0000-4000-8000-000000000201",
            miles: "18.25"
          }
        ]
      })
    ).not.toThrow();

    expect(() =>
      validateGlCodingResponsePayload({
        coded_line_items: [
          {
            status: "unmapped",
            line_item_id: "00000000-0000-4000-8000-000000000101",
            category: "Meals",
            unmapped_marker: "UNMAPPED_GL_CATEGORY",
            flagged: false
          }
        ],
        coded_mileage_entries: [
          {
            status: "mapped",
            mileage_entry_id: "00000000-0000-4000-8000-000000000201",
            miles: "18.25",
            reimbursable_amount: "12.23",
            category: "Mileage",
            gl_code_id: "00000000-0000-4000-8000-000000000301",
            account_code: "6300",
            account_name: "Synthetic Mileage Expense",
            normal_balance: "debit"
          }
        ],
        flagged_line_item: null
      })
    ).not.toThrow();
  });

  it("rejects malformed GL coding payloads", () => {
    expect(() =>
      validateGlCodingRequestPayload({
        line_items: [
          {
            line_item_id: "00000000-0000-4000-8000-000000000101",
            amount: "42.50",
            currency: "USD",
            category: "Travel"
          }
        ]
      })
    ).toThrow("GL coding request does not match the shared schema.");

    expect(() =>
      validateGlCodingResponsePayload({
        coded_line_items: [
          {
            status: "unmapped",
            line_item_id: "00000000-0000-4000-8000-000000000101",
            category: "Meals",
            flagged: false
          }
        ],
        coded_mileage_entries: [],
        flagged_line_item: null
      })
    ).toThrow("GL coding response does not match the shared schema.");
  });
});
