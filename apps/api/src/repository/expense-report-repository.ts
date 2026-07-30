import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  auditEntry,
  eventOutbox,
  expenseReport,
  expenseReportStages,
  lineItem,
  mileageEntry,
  receipt,
  stageTransition
} from "../db/schema.js";
import {
  buildExpenseReportStageTransitionedEvent,
  EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE
} from "../events/expense-report-stage-transitioned.event.js";
import { ConflictError } from "../errors/problem-json.js";
import type {
  AuditEntrySelect,
  ExpenseReportInsert,
  ExpenseReportSelect,
  LineItemSelect,
  MileageEntrySelect
} from "../db/schema.js";
import type {
  ApprovalQueueLineItem,
  CaseQueueItem,
  CaseQueueStageSummary
} from "../schemas/expense-report.schema.js";
import type { ExpenseReportStage } from "../schemas/expense-report.schema.js";
import { auditEntryWriteSchema } from "../schemas/audit-entry.schema.js";
import type {
  CreateExpenseReportRequest,
  CreateExpenseDraftExpenseReportRequest,
  CreateMileageDraftExpenseReportRequest
} from "../schemas/expense-report.schema.js";

type ExpenseReportDatabase = NodePgDatabase<typeof schema>;

export type ExpenseReportWithLineItems = ExpenseReportSelect & {
  lineItems: LineItemSelect[];
};

export type ExpenseReportForSubmit = ExpenseReportSelect & {
  lineItems: LineItemSelect[];
  mileageEntries: MileageEntrySelect[];
};

export interface ExpenseReportRepository {
  createDraftReport(report: CreateDraftReportInsert): Promise<ExpenseReportSelect>;
  findById(id: string, tenantId: string): Promise<ExpenseReportSelect | null>;
  findForSubmit(id: string, tenantId: string): Promise<ExpenseReportForSubmit | null>;
  listApprovalQueueLineItems(tenantId: string): Promise<ApprovalQueueLineItem[]>;
  listCaseQueue(tenantId: string): Promise<CaseQueueItem[]>;
  listCaseQueueRollup(tenantId: string): Promise<CaseQueueStageSummary[]>;
  listAuditEntries(expenseReportId: string, tenantId: string): Promise<AuditEntrySelect[]>;
  listWithLineItems(tenantId: string): Promise<ExpenseReportWithLineItems[]>;
  approveLineItem(request: LineItemActionRequest): Promise<ApprovalQueueLineItem>;
  rejectLineItem(request: LineItemActionRequest): Promise<ApprovalQueueLineItem>;
  clearLineItemFlag(request: LineItemActionRequest): Promise<ApprovalQueueLineItem>;
  updateLineItemDeductible(
    request: UpdateLineItemDeductibleRequest
  ): Promise<ApprovalQueueLineItem>;
  issuePayment(request: IssuePaymentRequest): Promise<ExpenseReportSelect>;
  voidIssuedPayment(request: VoidIssuedPaymentRequest): Promise<void>;
  unreconcileSettlement(request: UnreconcileSettlementRequest): Promise<void>;
  submitForApReview(request: SubmitForApReviewRequest): Promise<ExpenseReportSelect>;
  transitionStage(request: TransitionStageRequest): Promise<ExpenseReportSelect>;
  recordDeniedTransition(request: RecordDeniedTransitionRequest): Promise<void>;
}

export type CreateDraftReportInsert = ExpenseReportInsert & {
  draftType?: CreateExpenseReportRequest["draftType"];
  lineItems?: CreateExpenseDraftExpenseReportRequest["lineItems"];
  mileageEntries?: CreateMileageDraftExpenseReportRequest["mileageEntries"];
};

export interface SubmitForApReviewRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  correlationId: string;
  flaggedLineItemIds: string[];
  codedLineItems: CodedLineItemForPersistence[];
}

export interface CodedLineItemForPersistence {
  id: string;
  status: "mapped" | "unmapped";
  flagged: boolean;
  glCodeId: string | null;
  accountCode: string | null;
  accountName: string | null;
  normalBalance: "debit" | "credit" | null;
  unmappedMarker: string | null;
}

export interface TransitionStageRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  fromStage: ExpenseReportStage;
  toStage: ExpenseReportStage;
  reason: string;
  correlationId: string;
  action?: string;
}

export interface IssuePaymentRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  paymentId: string;
}

export type VoidIssuedPaymentRequest = IssuePaymentRequest & {
  reason: string;
};

export interface UnreconcileSettlementRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  reason: string;
  correlationId: string;
}

export interface RecordDeniedTransitionRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  action: string;
  reason: string;
}

export interface LineItemActionRequest {
  expenseReportId: string;
  lineItemId: string;
  tenantId: string;
  actorId: string;
}

export type UpdateLineItemDeductibleRequest = LineItemActionRequest & {
  deductible: boolean;
};

class DrizzleExpenseReportRepository implements ExpenseReportRepository {
  public constructor(
    private readonly db: ExpenseReportDatabase,
    private readonly now: () => Date,
    private readonly createEventId: () => string = randomUUID
  ) {}

  public async createDraftReport(insert: CreateDraftReportInsert): Promise<ExpenseReportSelect> {
    return this.db.transaction(async (tx) => {
      // draftType is an API-level discriminator and is intentionally excluded from persistence.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { lineItems, mileageEntries, draftType: _draftType, ...reportInsert } = insert;
      const [report] = await tx.insert(expenseReport).values(reportInsert).returning();

      if (report === undefined) {
        throw new Error("Expense Report creation failed.");
      }

      if (mileageEntries !== undefined) {
        await tx.insert(mileageEntry).values(
          mileageEntries.map((entry) => ({
            tenant_id: report.tenantId,
            expense_report_id: report.id,
            trip_date: entry.trip_date,
            origin: entry.origin,
            destination: entry.destination,
            miles: entry.miles.toFixed(2),
            business_purpose: entry.business_purpose
          }))
        );
      }

      if (lineItems !== undefined) {
        for (const item of lineItems) {
          const [createdLineItem] = await tx
            .insert(lineItem)
            .values({
              tenant_id: report.tenantId,
              expense_report_id: report.id,
              merchant: item.merchant,
              amount_cents: item.amount_cents,
              currency: item.currency,
              category: item.category
            })
            .returning();

          if (createdLineItem === undefined) {
            throw new Error("Expense line item creation failed.");
          }

          await tx.insert(receipt).values({
            tenant_id: report.tenantId,
            expense_report_id: report.id,
            expense_line_item_id: createdLineItem.id,
            receipt_number: item.receipt.receipt_number,
            merchant: item.receipt.merchant,
            receipt_date: item.receipt.receipt_date,
            amount_cents: item.receipt.amount_cents,
            currency: item.receipt.currency
          });
        }
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

  public async listCaseQueue(tenantId: string): Promise<CaseQueueItem[]> {
    return this.db
      .select({
        id: expenseReport.id,
        currentStage: expenseReport.currentStage,
        priority: expenseReport.priority,
        dueDate: expenseReport.dueDate,
        onHold: expenseReport.onHold,
        updatedAt: expenseReport.updatedAt
      })
      .from(expenseReport)
      .where(
        and(
          eq(expenseReport.tenantId, tenantId),
          inArray(expenseReport.currentStage, ["Submitted", "Manager Approval", "AP Review"])
        )
      )
      .orderBy(
        asc(expenseReport.dueDate),
        sql`case ${expenseReport.priority}
          when 'Urgent' then 1
          when 'High' then 2
          when 'Normal' then 3
          when 'Low' then 4
          else 5
        end`,
        asc(expenseReport.updatedAt),
        asc(expenseReport.id)
      );
  }

  public async listCaseQueueRollup(tenantId: string): Promise<CaseQueueStageSummary[]> {
    const rows = await this.db
      .select({
        stage: expenseReport.currentStage,
        reportCount: sql<number>`count(*)::integer`,
        overdueCount: sql<number>`count(*) filter (where ${expenseReport.dueDate} < current_date)::integer`
      })
      .from(expenseReport)
      .where(eq(expenseReport.tenantId, tenantId))
      .groupBy(expenseReport.currentStage);
    const countsByStage = new Map(
      rows.map((row) => [
        row.stage,
        {
          reportCount: Number(row.reportCount),
          overdueCount: Number(row.overdueCount)
        }
      ])
    );

    return expenseReportStages.map((stage) => ({
      stage,
      reportCount: countsByStage.get(stage)?.reportCount ?? 0,
      overdueCount: countsByStage.get(stage)?.overdueCount ?? 0
    }));
  }

  public async listApprovalQueueLineItems(tenantId: string): Promise<ApprovalQueueLineItem[]> {
    return this.selectApprovalQueueLineItems()
      .where(
        and(
          eq(expenseReport.tenantId, tenantId),
          eq(lineItem.tenant_id, tenantId),
          inArray(expenseReport.currentStage, ["Manager Approval", "AP Review"])
        )
      )
      .orderBy(asc(expenseReport.dueDate), asc(lineItem.created_at), asc(lineItem.id));
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
          currentStage: "Submitted",
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

      for (const item of request.codedLineItems) {
        await tx
          .update(lineItem)
          .set({
            flagged: item.flagged,
            gl_coding_status: item.status,
            gl_code_id: item.glCodeId,
            gl_account_code: item.accountCode,
            gl_account_name: item.accountName,
            gl_normal_balance: item.normalBalance,
            gl_unmapped_marker: item.unmappedMarker
          })
          .where(
            and(
              eq(lineItem.tenant_id, request.tenantId),
              eq(lineItem.expense_report_id, request.expenseReportId),
              eq(lineItem.id, item.id)
            )
          );
      }

      await tx.insert(stageTransition).values({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        fromStage: "Drafted",
        toStage: "Submitted",
        actorId: request.actorId,
        reason: "Expense Report submitted after GL coding."
      });
      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: "Expense Report Submitted",
          reason: "Expense Report submitted after GL coding.",
          result: "success",
          occurredAt: this.now()
        })
      );
      await tx.insert(eventOutbox).values({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: buildExpenseReportStageTransitionedEvent({
          id: this.createEventId(),
          time: this.now().toISOString(),
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          fromStage: "Drafted",
          toStage: "Submitted",
          correlationId: request.correlationId
        })
      });

      return updatedReport;
    });
  }

  public async approveLineItem(request: LineItemActionRequest): Promise<ApprovalQueueLineItem> {
    return this.updateManagerReviewStatus(request, "approved", "Expense Line Item Approved");
  }

  public async rejectLineItem(request: LineItemActionRequest): Promise<ApprovalQueueLineItem> {
    return this.updateManagerReviewStatus(request, "rejected", "Expense Line Item Rejected");
  }

  public async clearLineItemFlag(request: LineItemActionRequest): Promise<ApprovalQueueLineItem> {
    return this.db.transaction(async (tx) => {
      const report = await readReportForLineItemAction(tx, request);
      assertReportStage(report, "Manager Approval");

      const [updatedLineItem] = await tx
        .update(lineItem)
        .set({
          flag_cleared: true
        })
        .where(
          and(
            eq(lineItem.tenant_id, request.tenantId),
            eq(lineItem.expense_report_id, request.expenseReportId),
            eq(lineItem.id, request.lineItemId),
            eq(lineItem.flagged, true),
            eq(lineItem.flag_cleared, false)
          )
        )
        .returning();

      if (updatedLineItem === undefined) {
        throw new ConflictError("Only uncleared flagged line items can be cleared.");
      }

      await this.insertLineItemAudit(tx, {
        ...request,
        action: "Expense Line Item Flag Cleared",
        reason: "Over-500 line item flag cleared by reviewer."
      });

      return readApprovalQueueLineItem(tx, request);
    });
  }

  public async updateLineItemDeductible(
    request: UpdateLineItemDeductibleRequest
  ): Promise<ApprovalQueueLineItem> {
    return this.db.transaction(async (tx) => {
      const report = await readReportForLineItemAction(tx, request);
      assertReportStage(report, "AP Review");

      const [updatedLineItem] = await tx
        .update(lineItem)
        .set({
          deductible: request.deductible
        })
        .where(
          and(
            eq(lineItem.tenant_id, request.tenantId),
            eq(lineItem.expense_report_id, request.expenseReportId),
            eq(lineItem.id, request.lineItemId)
          )
        )
        .returning();

      if (updatedLineItem === undefined) {
        throw new ConflictError("Expense line item could not be updated.");
      }

      await this.insertLineItemAudit(tx, {
        ...request,
        action: "Expense Line Item Deductibility Updated",
        reason: `Expense line item marked ${request.deductible ? "deductible" : "non-deductible"}.`
      });

      return readApprovalQueueLineItem(tx, request);
    });
  }

  public async issuePayment(request: IssuePaymentRequest): Promise<ExpenseReportSelect> {
    return this.db.transaction(async (tx) => {
      const [updatedReport] = await tx
        .update(expenseReport)
        .set({
          paymentId: request.paymentId,
          updatedAt: this.now()
        })
        .where(
          and(
            eq(expenseReport.id, request.expenseReportId),
            eq(expenseReport.tenantId, request.tenantId),
            eq(expenseReport.currentStage, "Paid"),
            sql`${expenseReport.paymentId} is null`
          )
        )
        .returning();

      if (updatedReport === undefined) {
        const existingReport = await readReport(tx, request.expenseReportId, request.tenantId);

        if (
          existingReport?.currentStage === "Paid" &&
          existingReport.paymentId === request.paymentId
        ) {
          return existingReport;
        }

        throw new ConflictError("Expense Report must be Paid with no issued payment.");
      }

      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: "Expense Report Payment Issued",
          reason: "Synthetic settlement payment issued.",
          result: "success",
          occurredAt: this.now()
        })
      );

      return updatedReport;
    });
  }

  public async voidIssuedPayment(request: VoidIssuedPaymentRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [updatedReport] = await tx
        .update(expenseReport)
        .set({
          paymentId: null,
          updatedAt: this.now()
        })
        .where(
          and(
            eq(expenseReport.id, request.expenseReportId),
            eq(expenseReport.tenantId, request.tenantId),
            eq(expenseReport.paymentId, request.paymentId)
          )
        )
        .returning();

      if (updatedReport === undefined) {
        return;
      }

      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: "Expense Report Payment Voided",
          reason: request.reason,
          result: "success",
          occurredAt: this.now()
        })
      );
    });
  }

  public async unreconcileSettlement(request: UnreconcileSettlementRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [updatedReport] = await tx
        .update(expenseReport)
        .set({
          currentStage: "Paid",
          updatedAt: this.now()
        })
        .where(
          and(
            eq(expenseReport.id, request.expenseReportId),
            eq(expenseReport.tenantId, request.tenantId),
            eq(expenseReport.currentStage, "Reconciled")
          )
        )
        .returning();

      if (updatedReport === undefined) {
        return;
      }

      await tx.insert(stageTransition).values({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        fromStage: "Reconciled",
        toStage: "Paid",
        actorId: request.actorId,
        reason: request.reason
      });
      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: "Expense Report Reconciliation Compensated",
          reason: request.reason,
          result: "success",
          occurredAt: this.now()
        })
      );
      await tx.insert(eventOutbox).values({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: buildExpenseReportStageTransitionedEvent({
          id: this.createEventId(),
          time: this.now().toISOString(),
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          fromStage: "Reconciled",
          toStage: "Paid",
          correlationId: request.correlationId
        })
      });
    });
  }

  public async transitionStage(request: TransitionStageRequest): Promise<ExpenseReportSelect> {
    return this.db.transaction(async (tx) => {
      const [updatedReport] = await tx
        .update(expenseReport)
        .set({
          currentStage: request.toStage,
          updatedAt: this.now()
        })
        .where(
          and(
            eq(expenseReport.id, request.expenseReportId),
            eq(expenseReport.tenantId, request.tenantId),
            eq(expenseReport.currentStage, request.fromStage)
          )
        )
        .returning();

      if (updatedReport === undefined) {
        throw new ConflictError(`Expense Report must be ${request.fromStage} before transition.`);
      }

      await tx.insert(stageTransition).values({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        fromStage: request.fromStage,
        toStage: request.toStage,
        actorId: request.actorId,
        reason: request.reason
      });
      await tx.insert(auditEntry).values(
        auditEntryWriteSchema.parse({
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          actorId: request.actorId,
          action: request.action ?? "Expense Report Advanced",
          reason: request.reason,
          result: "success",
          occurredAt: this.now()
        })
      );
      await tx.insert(eventOutbox).values({
        eventType: EXPENSE_REPORT_STAGE_TRANSITIONED_EVENT_TYPE,
        payload: buildExpenseReportStageTransitionedEvent({
          id: this.createEventId(),
          time: this.now().toISOString(),
          tenantId: request.tenantId,
          expenseReportId: request.expenseReportId,
          fromStage: request.fromStage,
          toStage: request.toStage,
          correlationId: request.correlationId
        })
      });

      return updatedReport;
    });
  }

  public async recordDeniedTransition(request: RecordDeniedTransitionRequest): Promise<void> {
    await this.db.insert(auditEntry).values(
      auditEntryWriteSchema.parse({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        actorId: request.actorId,
        action: request.action,
        reason: request.reason,
        result: "failure",
        occurredAt: this.now()
      })
    );
  }

  private async updateManagerReviewStatus(
    request: LineItemActionRequest,
    managerReviewStatus: "approved" | "rejected",
    action: string
  ): Promise<ApprovalQueueLineItem> {
    return this.db.transaction(async (tx) => {
      const report = await readReportForLineItemAction(tx, request);
      assertReportStage(report, "Manager Approval");

      const [updatedLineItem] = await tx
        .update(lineItem)
        .set({
          manager_review_status: managerReviewStatus
        })
        .where(
          and(
            eq(lineItem.tenant_id, request.tenantId),
            eq(lineItem.expense_report_id, request.expenseReportId),
            eq(lineItem.id, request.lineItemId),
            eq(lineItem.manager_review_status, "pending")
          )
        )
        .returning();

      if (updatedLineItem === undefined) {
        throw new ConflictError("Only pending Expense line items can be reviewed.");
      }

      await this.insertLineItemAudit(tx, {
        ...request,
        action,
        reason: `Expense line item ${managerReviewStatus} by reviewer.`
      });

      return readApprovalQueueLineItem(tx, request);
    });
  }

  private async insertLineItemAudit(
    tx: ExpenseReportDatabase,
    request: LineItemActionRequest & { action: string; reason: string }
  ): Promise<void> {
    await tx.insert(auditEntry).values(
      auditEntryWriteSchema.parse({
        tenantId: request.tenantId,
        expenseReportId: request.expenseReportId,
        actorId: request.actorId,
        action: request.action,
        reason: request.reason,
        result: "success",
        occurredAt: this.now()
      })
    );
  }

  private selectApprovalQueueLineItems() {
    return this.db
      .select(approvalQueueSelection)
      .from(lineItem)
      .innerJoin(
        expenseReport,
        and(
          eq(expenseReport.tenantId, lineItem.tenant_id),
          eq(expenseReport.id, lineItem.expense_report_id)
        )
      );
  }
}

export function createExpenseReportRepository(
  db: ExpenseReportDatabase = getDb(),
  now: () => Date = () => new Date(),
  createEventId: () => string = randomUUID
): ExpenseReportRepository {
  return new DrizzleExpenseReportRepository(db, now, createEventId);
}

const approvalQueueSelection = {
  reportId: expenseReport.id,
  reportStage: expenseReport.currentStage,
  lineItemId: lineItem.id,
  merchant: lineItem.merchant,
  amountCents: lineItem.amount_cents,
  currency: lineItem.currency,
  category: lineItem.category,
  flagged: lineItem.flagged,
  flagCleared: lineItem.flag_cleared,
  glCodingStatus: lineItem.gl_coding_status,
  glCodeId: lineItem.gl_code_id,
  glAccountCode: lineItem.gl_account_code,
  glAccountName: lineItem.gl_account_name,
  deductible: lineItem.deductible,
  managerReviewStatus: lineItem.manager_review_status,
  createdAt: lineItem.created_at
};

async function readReport(
  db: ExpenseReportDatabase,
  id: string,
  tenantId: string
): Promise<ExpenseReportSelect | null> {
  const [report] = await db
    .select()
    .from(expenseReport)
    .where(and(eq(expenseReport.id, id), eq(expenseReport.tenantId, tenantId)))
    .limit(1);

  return report ?? null;
}

async function readReportForLineItemAction(
  db: ExpenseReportDatabase,
  request: LineItemActionRequest
): Promise<ExpenseReportSelect> {
  const [report] = await db
    .select()
    .from(expenseReport)
    .innerJoin(
      lineItem,
      and(
        eq(lineItem.tenant_id, expenseReport.tenantId),
        eq(lineItem.expense_report_id, expenseReport.id)
      )
    )
    .where(
      and(
        eq(expenseReport.id, request.expenseReportId),
        eq(expenseReport.tenantId, request.tenantId),
        eq(lineItem.id, request.lineItemId)
      )
    )
    .limit(1);

  if (report === undefined) {
    throw new ConflictError("Expense line item could not be updated.");
  }

  return report.expense_report;
}

async function readApprovalQueueLineItem(
  db: ExpenseReportDatabase,
  request: LineItemActionRequest
): Promise<ApprovalQueueLineItem> {
  const [row] = await db
    .select(approvalQueueSelection)
    .from(lineItem)
    .innerJoin(
      expenseReport,
      and(
        eq(expenseReport.tenantId, lineItem.tenant_id),
        eq(expenseReport.id, lineItem.expense_report_id)
      )
    )
    .where(
      and(
        eq(expenseReport.id, request.expenseReportId),
        eq(expenseReport.tenantId, request.tenantId),
        eq(lineItem.id, request.lineItemId)
      )
    )
    .limit(1);

  if (row === undefined) {
    throw new ConflictError("Expense line item could not be read after update.");
  }

  return row;
}

function assertReportStage(report: ExpenseReportSelect, expectedStage: ExpenseReportStage): void {
  if (report.currentStage !== expectedStage) {
    throw new ConflictError(`Expense Report must be ${expectedStage} for this line item action.`);
  }
}
