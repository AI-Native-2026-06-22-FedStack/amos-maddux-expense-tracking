import { describe, expect, it } from "vitest";

import {
  ExpenseReportTransaction,
  InMemoryExpenseReportTransactionStore,
  summarizeExpenseReportTransactions
} from "./expense-report-transactions.js";

describe("summarizeExpenseReportTransactions", () => {
  it("summarizes valid synthetic expense report transactions", async () => {
    const transactions: readonly ExpenseReportTransaction[] = [
      { amount: 24.5, currency: "USD", category: "Meals" },
      { amount: 150, currency: "USD", category: "Lodging" },
      { amount: 48, currency: "CAD", category: "Mileage" }
    ];
    const store = new InMemoryExpenseReportTransactionStore(transactions);

    const result = await summarizeExpenseReportTransactions(store);

    expect(result).toEqual({
      ok: true,
      summary: {
        transactionCount: 3,
        totalAmount: 222.5,
        totalsByCurrency: {
          USD: 174.5,
          CAD: 48
        },
        totalsByCategory: {
          Meals: 24.5,
          Lodging: 150,
          Mileage: 48,
          Supplies: 0,
          Other: 0
        }
      }
    });
  });

  it("returns typed validation details for malformed boundary input", async () => {
    const store = new InMemoryExpenseReportTransactionStore([
      { amount: -10, currency: "usd", category: "Meals" }
    ]);

    const result = await summarizeExpenseReportTransactions(store);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.message).toBe("Expense Report transaction validation failed.");
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("lets callers type records from the schema-inferred transaction type", async () => {
    const transaction: ExpenseReportTransaction = {
      amount: 12,
      currency: "USD",
      category: "Supplies"
    };
    const store = new InMemoryExpenseReportTransactionStore([transaction]);

    const result = await summarizeExpenseReportTransactions(store);

    expect(result.ok).toBe(true);
  });
});
