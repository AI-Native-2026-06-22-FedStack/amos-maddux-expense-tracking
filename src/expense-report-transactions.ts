import { z } from "zod";

export const expenseReportCategorySchema = z.enum([
  "Meals",
  "Lodging",
  "Mileage",
  "Supplies",
  "Other"
]);

export const expenseReportTransactionSchema = z.object({
  amount: z.number().finite().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  category: expenseReportCategorySchema
});

export type ExpenseReportTransaction = z.infer<typeof expenseReportTransactionSchema>;
export type ExpenseReportCategory = ExpenseReportTransaction["category"];

export interface ExpenseReportTransactionStore {
  listTransactions(): Promise<readonly unknown[]>;
}

export class InMemoryExpenseReportTransactionStore implements ExpenseReportTransactionStore {
  public constructor(private readonly transactions: readonly unknown[]) {}

  public async listTransactions(): Promise<readonly unknown[]> {
    return this.transactions;
  }
}

export interface ExpenseReportTransactionSummary {
  transactionCount: number;
  totalAmount: number;
  totalsByCurrency: Readonly<Record<string, number>>;
  totalsByCategory: Readonly<Record<ExpenseReportCategory, number>>;
}

export interface ExpenseReportTransactionValidationError {
  message: string;
  issues: readonly string[];
}

export type ExpenseReportTransactionSummaryResult =
  | { ok: true; summary: ExpenseReportTransactionSummary }
  | { ok: false; error: ExpenseReportTransactionValidationError };

const emptyTotalsByCategory = (): Record<ExpenseReportCategory, number> => ({
  Meals: 0,
  Lodging: 0,
  Mileage: 0,
  Supplies: 0,
  Other: 0
});

// The store accepts unknown boundary records while the helper returns a typed result so validation and error handling stay explicit.
export async function summarizeExpenseReportTransactions(
  store: ExpenseReportTransactionStore
): Promise<ExpenseReportTransactionSummaryResult> {
  try {
    const rawTransactions = await store.listTransactions();
    const parsedTransactions = z.array(expenseReportTransactionSchema).safeParse(rawTransactions);

    if (!parsedTransactions.success) {
      return {
        ok: false,
        error: {
          message: "Expense Report transaction validation failed.",
          issues: parsedTransactions.error.issues.map((issue) => issue.message)
        }
      };
    }

    const totalsByCurrency: Record<string, number> = {};
    const totalsByCategory = emptyTotalsByCategory();

    for (const transaction of parsedTransactions.data) {
      totalsByCurrency[transaction.currency] =
        (totalsByCurrency[transaction.currency] ?? 0) + transaction.amount;
      totalsByCategory[transaction.category] += transaction.amount;
    }

    return {
      ok: true,
      summary: {
        transactionCount: parsedTransactions.data.length,
        totalAmount: parsedTransactions.data.reduce(
          (total, transaction) => total + transaction.amount,
          0
        ),
        totalsByCurrency,
        totalsByCategory
      }
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown async store failure.";

    return {
      ok: false,
      error: {
        message: "Expense Report transaction summary failed.",
        issues: [message]
      }
    };
  }
}
