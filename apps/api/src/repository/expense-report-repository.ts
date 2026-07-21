import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  auditEntry,
  expenseReport,
  lineItem,
  mileageEntry,
  stageTransition
} from "../db/schema.js";
import { ConflictError } from "../errors/problem-json.js";
import type {
  AuditEntrySelect,
  ExpenseReportInsert,
  ExpenseReportSelect,
  LineItemSelect,
  MileageEntrySelect
} from "../db/schema.js";
import { auditEntryWriteSchema } from "../schemas/audit-entry.schema.js";

type ExpenseReportDatabase = NodePgDatabase<typeof schema>;

export type ExpenseReportWithLineItems = ExpenseReportSelect & {
  lineItems: LineItemSelect[];
};

export type ExpenseReportForSubmit = ExpenseReportSelect & {
  lineItems: LineItemSelect[];
  mileageEntries: MileageEntrySelect[];
};

export interface ExpenseReportRepository {
  createDraftReport(report: ExpenseReportInsert): Promise<ExpenseReportSelect>;
  findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null>;
  findForSubmit(id: string, tenantId: string): Promise<ExpenseReportForSubmit | null>;
  listAuditEntries(expenseReportId: string, tenantId: string): Promise<AuditEntrySelect[]>;
  listWithLineItems(tenantId: string): Promise<ExpenseReportWithLineItems[]>;
  submitForApReview(request: SubmitForApReviewRequest): Promise<ExpenseReportSelect>;
}

export interface SubmitForApReviewRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  flaggedLineItemIds: string[];
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

  public async findForSubmit(id: string, tenantId: string): Promise<ExpenseReportForSubmit | null> {
    const report = await this.findById(id, tenantId);
    if (report === null) {
      return null;
    }

    const lineItems = await this.db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.expense_report_id, id), eq(lineItem.tenant_id, tenantId)))
      .orderBy(asc(lineItem.created_at), asc(lineItem.id));
    const mileageEntries = await this.db
      .select()
      .from(mileageEntry)
      .where(and(eq(mileageEntry.expense_report_id, id), eq(mileageEntry.tenant_id, tenantId)))
      .orderBy(asc(mileageEntry.created_at), asc(mileageEntry.id));

    return {
      ...report,
      lineItems,
      mileageEntries
    };
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

  public async submitForApReview(request: SubmitForApReviewRequest): Promise<ExpenseReportSelect> {
    return this.db.transaction(async (tx) => {
      const [updatedReport] = await tx
        .update(expenseReport)
        .set({
          currentStage: "AP Review",
          updatedAt: this.now()
        })
        .where(
          and(
            eq(expenseReport.id, request.expenseReportId),
            eq(expenseReport.tenantId, request.tenantId),
            eq(expenseReport.currentStage, "Drafted")
          )
        )
        .returning();

      if (updatedReport === undefined) {
        throw new ConflictError("Expense Report must be Drafted before submit.");
      }

      if (request.flaggedLineItemIds.length > 0) {
        await tx
          .update(lineItem)
          .set({ flagged: true })
          .where(
            and(
              eq(lineItem.tenant_id, request.tenantId),
              eq(lineItem.expense_report_id, request.expenseReportId),
              inArray(lineItem.id, request.flaggedLineItemIds)
            )
          );
      }

      await tx.insert(stageTransition).values({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        fromStage: "Drafted",
        toStage: "AP Review",
        actorId: request.actorId,
        reason: "Expense Report submitted for AP Review."
      });
      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: "Expense Report Submitted",
          reason: "Expense Report submitted for AP Review after GL coding.",
          result: "success",
          occurredAt: this.now()
        })
      );

      return updatedReport;
    });
  }
}

export function createExpenseReportRepository(
  db: ExpenseReportDatabase = getDb(),
  now: () => Date = () => new Date()
): ExpenseReportRepository {
  return new DrizzleExpenseReportRepository(db, now);
}
