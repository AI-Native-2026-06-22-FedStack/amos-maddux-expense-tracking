import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { auditEntry, expenseReport, lineItem, stageTransition } from "../db/schema.js";
import type {
  AuditEntrySelect,
  ExpenseReportInsert,
  ExpenseReportSelect,
  LineItemSelect
} from "../db/schema.js";
import { auditEntryWriteSchema } from "../schemas/audit-entry.schema.js";

type ExpenseReportDatabase = NodePgDatabase<typeof schema>;

export type ExpenseReportWithLineItems = ExpenseReportSelect & {
  lineItems: LineItemSelect[];
};

export interface ExpenseReportRepository {
  createDraftReport(report: ExpenseReportInsert): Promise<ExpenseReportSelect>;
  findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null>;
  listAuditEntries(expenseReportId: string, tenantId: string): Promise<AuditEntrySelect[]>;
  listWithLineItems(tenantId: string): Promise<ExpenseReportWithLineItems[]>;
}

class DrizzleExpenseReportRepository implements ExpenseReportRepository {
  public constructor(
    private readonly db: ExpenseReportDatabase,
    private readonly now: () => Date
  ) {}

  public async createDraftReport(insert: ExpenseReportInsert): Promise<ExpenseReportSelect> {
    return this.db.transaction(async (tx) => {
      const [report] = await tx.insert(expenseReport).values(insert).returning();

      if (report === undefined) {
        throw new Error("Expense Report creation failed.");
      }

      await tx.insert(stageTransition).values({
        tenantId: report.tenantId,
        expenseReportId: report.id,
        fromStage: null,
        toStage: "Drafted",
        actorId: report.submitterId,
        reason: "Expense Report created."
      });
      // audit_entry is append-only because PostgreSQL triggers reject UPDATE and DELETE; application code only inserts and selects.
      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: report.tenantId,
          expenseReportId: report.id,
          actorId: report.submitterId,
          action: "Expense Report Created",
          reason: "Expense Report created in Drafted stage.",
          result: "success",
          occurredAt: this.now()
        })
      );

      return report;
    });
  }

  public async findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null> {
    const [report] = await this.db
      .select()
      .from(expenseReport)
      .where(and(eq(expenseReport.id, id), eq(expenseReport.tenantId, tenantId)))
      .limit(1);

    return report ?? null;
  }

  public async listAuditEntries(
    expenseReportId: string,
    tenantId: string
  ): Promise<AuditEntrySelect[]> {
    return this.db
      .select()
      .from(auditEntry)
      .where(
        and(eq(auditEntry.expenseReportId, expenseReportId), eq(auditEntry.tenantId, tenantId))
      )
      .orderBy(asc(auditEntry.occurredAt), asc(auditEntry.id));
  }

  public async listWithLineItems(tenantId: string): Promise<ExpenseReportWithLineItems[]> {
    // Future cache-aside read check belongs here before querying PostgreSQL.
    const rows = await this.db
      .select({ report: expenseReport, lineItem })
      .from(expenseReport)
      .leftJoin(
        lineItem,
        and(eq(lineItem.expense_report_id, expenseReport.id), eq(lineItem.tenant_id, tenantId))
      )
      .where(eq(expenseReport.tenantId, tenantId));

    const reportsById = new Map<string, ExpenseReportWithLineItems>();

    for (const row of rows) {
      const report =
        reportsById.get(row.report.id) ??
        ({
          ...row.report,
          lineItems: []
        } satisfies ExpenseReportWithLineItems);

      if (row.lineItem !== null) {
        report.lineItems.push(row.lineItem);
      }

      reportsById.set(row.report.id, report);
    }

    return [...reportsById.values()];
  }
}

export function createExpenseReportRepository(
  db: ExpenseReportDatabase = getDb(),
  now: () => Date = () => new Date()
): ExpenseReportRepository {
  return new DrizzleExpenseReportRepository(db, now);
}
