import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/db/schema.js";
import {
  auditEntry,
  expenseReport,
  lineItem,
  mileageEntry,
  stageTransition
} from "../src/db/schema.js";
import { ConflictError } from "../src/errors/problem-json.js";
import { createExpenseReportRepository } from "../src/repository/expense-report-repository.js";
import { makeExpenseReport } from "./factories/make-expense-report.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000401";
const tenantB = "00000000-0000-4000-8000-000000000402";

describe("ExpenseReportRepository integration", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("inserts and reads an Expense Report for the same tenant", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const report = makeExpenseReport({ tenantId: tenantA });

    const created = await repository.createDraftReport({
      tenantId: report.tenantId,
      submitterId: report.submitterId
    });
    const found = await repository.findById(created.id, tenantA);

    expect(found).toEqual(created);
    expect(found).toMatchObject({
      id: created.id,
      tenantId: tenantA,
      submitterId: report.submitterId,
      assignedOwnerId: null,
      managerApproverId: null,
      apReviewerId: null,
      paymentId: null,
      currentStage: "Drafted",
      priority: "Normal",
      dueDate: null,
      onHold: false,
      holdReason: null
    });
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.updatedAt).toBeInstanceOf(Date);
  });

  it("does not read another tenant's Expense Report", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const report = makeExpenseReport({ tenantId: tenantA });

    const created = await repository.createDraftReport({
      tenantId: report.tenantId,
      submitterId: report.submitterId
    });

    await expect(repository.findById(created.id, tenantB)).resolves.toBeNull();
  });

  it("does not list another tenant's audit entries for an Expense Report", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const report = makeExpenseReport({ tenantId: tenantA });

    const created = await repository.createDraftReport({
      tenantId: report.tenantId,
      submitterId: report.submitterId
    });

    await expect(repository.listAuditEntries(created.id, tenantA)).resolves.toHaveLength(1);
    await expect(repository.listAuditEntries(created.id, tenantB)).resolves.toEqual([]);
  });

  it("rolls back the Expense Report when audit validation fails", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db, () => new Date(Number.NaN));
    const report = makeExpenseReport({ tenantId: tenantA });

    await expect(
      repository.createDraftReport({
        tenantId: report.tenantId,
        submitterId: report.submitterId
      })
    ).rejects.toThrow();

    await expect(
      db.select().from(expenseReport).where(eq(expenseReport.tenantId, tenantA))
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(stageTransition).where(eq(stageTransition.tenantId, tenantA))
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(auditEntry).where(eq(auditEntry.tenantId, tenantA))
    ).resolves.toHaveLength(0);
  });

  it("lists Expense Reports with line items in a single tenant-scoped left join query", async () => {
    const logger = new QueryCountingLogger();
    const db = drizzle(client, { schema, logger });
    const repository = createExpenseReportRepository(db);
    const firstReport = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000411"
    });
    const secondReport = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000412"
    });
    const otherTenantReport = await repository.createDraftReport({
      tenantId: tenantB,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000413"
    });

    await db.insert(lineItem).values([
      {
        tenant_id: tenantA,
        expense_report_id: firstReport.id,
        merchant: "Synthetic Office Supply",
        amount_cents: 1200,
        currency: "USD",
        category: "Office"
      },
      {
        tenant_id: tenantA,
        expense_report_id: secondReport.id,
        merchant: "Synthetic Team Lunch",
        amount_cents: 2400,
        currency: "USD",
        category: "Meals"
      },
      {
        tenant_id: tenantB,
        expense_report_id: otherTenantReport.id,
        merchant: "Synthetic Other Tenant Vendor",
        amount_cents: 3600,
        currency: "USD",
        category: "Travel"
      }
    ]);

    logger.reset();
    const reports = await repository.listWithLineItems(tenantA);

    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.id).sort()).toEqual(
      [firstReport.id, secondReport.id].sort()
    );

    for (const report of reports) {
      expect(report.tenantId).toBe(tenantA);
      expect(report.lineItems).toHaveLength(1);

      for (const item of report.lineItems) {
        expect(item.tenant_id).toBe(tenantA);
        expect(item.expense_report_id).toBe(report.id);
      }
    }
    expect(logger.queryCount).toBe(1);
  });

  it("lists only actionable Case Queue reports for one tenant in deterministic order", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const urgentReview = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000414"
    });
    const highReview = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000415"
    });
    const drafted = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000416"
    });
    const paid = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000417"
    });
    const otherTenantReview = await repository.createDraftReport({
      tenantId: tenantB,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000418"
    });

    await db
      .update(expenseReport)
      .set({
        currentStage: "Manager Approval",
        dueDate: "2026-07-25",
        priority: "High"
      })
      .where(eq(expenseReport.id, highReview.id));
    await db
      .update(expenseReport)
      .set({
        currentStage: "Submitted",
        dueDate: "2026-07-25",
        priority: "Urgent"
      })
      .where(eq(expenseReport.id, urgentReview.id));
    await db
      .update(expenseReport)
      .set({
        currentStage: "AP Review",
        dueDate: "2026-07-24",
        priority: "Low"
      })
      .where(eq(expenseReport.id, otherTenantReview.id));
    await db
      .update(expenseReport)
      .set({ currentStage: "Paid", dueDate: "2026-07-23", priority: "Urgent" })
      .where(eq(expenseReport.id, paid.id));

    const queue = await repository.listCaseQueue(tenantA);

    expect(queue.map((report) => report.id)).toEqual([urgentReview.id, highReview.id]);
    expect(queue.every((report) => report.id !== drafted.id && report.id !== paid.id)).toBe(true);
    expect(queue.some((report) => report.id === otherTenantReview.id)).toBe(false);
  });

  it("finds submit data only for the requested tenant", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const tenantAReport = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000421"
    });
    const tenantBReport = await repository.createDraftReport({
      tenantId: tenantB,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000422"
    });

    await db.insert(lineItem).values([
      {
        tenant_id: tenantA,
        expense_report_id: tenantAReport.id,
        merchant: "Synthetic Tenant A Merchant",
        amount_cents: 50001,
        currency: "USD",
        category: "Meals"
      },
      {
        tenant_id: tenantB,
        expense_report_id: tenantBReport.id,
        merchant: "Synthetic Tenant B Merchant",
        amount_cents: 75000,
        currency: "USD",
        category: "Meals"
      }
    ]);
    await db.insert(mileageEntry).values([
      {
        tenant_id: tenantA,
        expense_report_id: tenantAReport.id,
        trip_date: "2026-07-17",
        origin: "Synthetic Origin A",
        destination: "Synthetic Destination A",
        miles: "18.25",
        business_purpose: "Synthetic tenant A purpose"
      },
      {
        tenant_id: tenantB,
        expense_report_id: tenantBReport.id,
        trip_date: "2026-07-18",
        origin: "Synthetic Origin B",
        destination: "Synthetic Destination B",
        miles: "42.00",
        business_purpose: "Synthetic tenant B purpose"
      }
    ]);

    const submitData = await repository.findForSubmit(tenantAReport.id, tenantA);

    expect(submitData?.id).toBe(tenantAReport.id);
    expect(submitData?.tenantId).toBe(tenantA);
    expect(submitData?.lineItems).toHaveLength(1);
    expect(submitData?.lineItems[0]?.tenant_id).toBe(tenantA);
    expect(submitData?.mileageEntries).toHaveLength(1);
    expect(submitData?.mileageEntries[0]?.tenant_id).toBe(tenantA);
    await expect(repository.findForSubmit(tenantAReport.id, tenantB)).resolves.toBeNull();
  });

  it("submits only the requested tenant report and flags only matching tenant line items", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const tenantAReport = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000431"
    });
    const tenantBReport = await repository.createDraftReport({
      tenantId: tenantB,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000432"
    });
    const [tenantALineItem] = await db
      .insert(lineItem)
      .values({
        tenant_id: tenantA,
        expense_report_id: tenantAReport.id,
        merchant: "Synthetic Tenant A Merchant",
        amount_cents: 50001,
        currency: "USD",
        category: "Meals"
      })
      .returning();
    const [tenantBLineItem] = await db
      .insert(lineItem)
      .values({
        tenant_id: tenantB,
        expense_report_id: tenantBReport.id,
        merchant: "Synthetic Tenant B Merchant",
        amount_cents: 50001,
        currency: "USD",
        category: "Meals"
      })
      .returning();

    const submitted = await repository.submitForApReview({
      expenseReportId: tenantAReport.id,
      tenantId: tenantA,
      actorId: "synthetic-actor-00000000-0000-4000-8000-000000000433",
      flaggedLineItemIds: [tenantALineItem.id, tenantBLineItem.id],
      codedLineItems: [
        {
          id: tenantALineItem.id,
          status: "mapped",
          flagged: true,
          glCodeId: "00000000-0000-4000-8000-000000000434",
          accountCode: "6100",
          accountName: "Synthetic Meals Expense",
          normalBalance: "debit",
          unmappedMarker: null
        }
      ]
    });
    const tenantBFound = await repository.findById(tenantBReport.id, tenantB);
    const tenantBLineItems = await db
      .select()
      .from(lineItem)
      .where(eq(lineItem.tenant_id, tenantB));

    expect(submitted.currentStage).toBe("Submitted");
    expect(tenantBFound?.currentStage).toBe("Drafted");
    expect(tenantBLineItems[0]?.flagged).toBe(false);
    await expect(repository.listAuditEntries(tenantAReport.id, tenantA)).resolves.toHaveLength(2);
    await expect(repository.listAuditEntries(tenantBReport.id, tenantB)).resolves.toHaveLength(1);
  });

  it("returns a conflict when the report is no longer Drafted at submit write time", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const report = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000441"
    });

    await db
      .update(expenseReport)
      .set({ currentStage: "AP Review" })
      .where(eq(expenseReport.id, report.id));

    await expect(
      repository.submitForApReview({
        expenseReportId: report.id,
        tenantId: tenantA,
        actorId: "synthetic-actor-00000000-0000-4000-8000-000000000442",
        flaggedLineItemIds: [],
        codedLineItems: []
      })
    ).rejects.toThrow(ConflictError);
  });

  it("advances and sends back reports with ordered transition and audit rows", async () => {
    const db = drizzle(client, { schema });
    const repository = createExpenseReportRepository(db);
    const report = await repository.createDraftReport({
      tenantId: tenantA,
      submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000451"
    });

    const submitted = await repository.submitForApReview({
      expenseReportId: report.id,
      tenantId: tenantA,
      actorId: "synthetic-submitter-00000000-0000-4000-8000-000000000451",
      flaggedLineItemIds: [],
      codedLineItems: []
    });
    const managerApproval = await repository.transitionStage({
      expenseReportId: report.id,
      tenantId: tenantA,
      actorId: "synthetic-manager-00000000-0000-4000-8000-000000000452",
      fromStage: "Submitted",
      toStage: "Manager Approval",
      reason: "Synthetic manager review."
    });
    const drafted = await repository.transitionStage({
      expenseReportId: report.id,
      tenantId: tenantA,
      actorId: "synthetic-manager-00000000-0000-4000-8000-000000000452",
      fromStage: "Manager Approval",
      toStage: "Drafted",
      reason: "Synthetic receipt needs detail.",
      action: "Expense Report Sent Back"
    });

    expect(submitted.currentStage).toBe("Submitted");
    expect(managerApproval.currentStage).toBe("Manager Approval");
    expect(drafted.currentStage).toBe("Drafted");

    const transitionRows = await db
      .select()
      .from(stageTransition)
      .where(eq(stageTransition.expenseReportId, report.id));
    const auditRows = await repository.listAuditEntries(report.id, tenantA);

    expect(transitionRows.map((row) => row.toStage)).toEqual([
      "Drafted",
      "Submitted",
      "Manager Approval",
      "Drafted"
    ]);
    expect(auditRows.map((row) => row.action)).toEqual([
      "Expense Report Created",
      "Expense Report Submitted",
      "Expense Report Advanced",
      "Expense Report Sent Back"
    ]);
  });
});

class QueryCountingLogger {
  public queryCount = 0;

  public logQuery(): void {
    this.queryCount += 1;
  }

  public reset(): void {
    this.queryCount = 0;
  }
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for Expense Report repository integration tests.");
  }

  return process.env.DATABASE_URI;
}
