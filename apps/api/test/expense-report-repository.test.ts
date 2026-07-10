import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/db/schema.js";
import { auditEntry, expenseReport, lineItem, stageTransition } from "../src/db/schema.js";
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

    await expect(db.select().from(expenseReport).where(eq(expenseReport.tenantId, tenantA))).resolves
      .toHaveLength(0);
    await expect(db.select().from(stageTransition).where(eq(stageTransition.tenantId, tenantA)))
      .resolves.toHaveLength(0);
    await expect(db.select().from(auditEntry).where(eq(auditEntry.tenantId, tenantA))).resolves
      .toHaveLength(0);
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
