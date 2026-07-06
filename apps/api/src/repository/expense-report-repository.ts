import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../db/schema.js";
import { expenseReport } from "../db/schema.js";
import type { ExpenseReportInsert, ExpenseReportSelect } from "../db/schema.js";

const { Pool } = pg;

type ExpenseReportDatabase = NodePgDatabase<typeof schema>;

export interface ExpenseReportRepository {
  createDraftReport(report: ExpenseReportInsert): Promise<ExpenseReportSelect>;
  findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null>;
}

class DrizzleExpenseReportRepository implements ExpenseReportRepository {
  public constructor(private readonly db: ExpenseReportDatabase) {}

  public async createDraftReport(insert: ExpenseReportInsert): Promise<ExpenseReportSelect> {
    const [report] = await this.db.insert(expenseReport).values(insert).returning();

    return report;
  }

  public async findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null> {
    const [report] = await this.db
      .select()
      .from(expenseReport)
      .where(and(eq(expenseReport.id, id), eq(expenseReport.tenantId, tenantId)))
      .limit(1);

    return report ?? null;
  }
}

export function createExpenseReportRepository(
  db: ExpenseReportDatabase = createDefaultDatabase()
): ExpenseReportRepository {
  return new DrizzleExpenseReportRepository(db);
}

function createDefaultDatabase(): ExpenseReportDatabase {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required to create the Expense Report repository.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  return drizzle(pool, { schema });
}
