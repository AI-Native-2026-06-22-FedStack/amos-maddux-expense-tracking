import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../src/db/schema.js";
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
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Expense Report repository integration tests.");
  }

  return process.env.DATABASE_URL;
}
