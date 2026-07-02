import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pg from "pg";

import { readCaseQueue } from "../src/repository/case-queue.js";
import type { CaseQueueQueryExecutor, ExpenseReportStage } from "../src/repository/case-queue.js";
import { makeExpenseReport } from "./factories/make-expense-report.js";
import type { ExpenseReportRow } from "./factories/make-expense-report.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000201";
const tenantB = "00000000-0000-4000-8000-000000000202";
const canonicalStages = [
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
] as const;

describe("readCaseQueue integration", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
    await truncateDatabase(client);
  });

  afterEach(async () => {
    await client.end();
  });

  it("returns only the requested tenant's Case Queue counts", async () => {
    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantA,
        current_stage: "Drafted",
        due_date: "2000-01-01"
      })
    );
    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantA,
        current_stage: "Drafted",
        due_date: "2999-01-01"
      })
    );
    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantA,
        current_stage: "Submitted",
        due_date: "2999-01-01"
      })
    );
    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantA,
        current_stage: "AP Review",
        due_date: "2999-01-01"
      })
    );

    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantB,
        current_stage: "Manager Approval",
        due_date: "2000-01-01"
      })
    );
    await insertExpenseReport(
      client,
      makeExpenseReport({
        tenant_id: tenantB,
        current_stage: "Paid",
        due_date: "2000-01-01"
      })
    );

    const summaries = await readCaseQueue(toCaseQueueExecutor(client), tenantA);

    expect(summaries.map((summary) => summary.stage)).toEqual(canonicalStages);
    expect(summaries).toEqual([
      { stage: "Drafted", reportCount: 2, overdueCount: 1 },
      { stage: "Submitted", reportCount: 1, overdueCount: 0 },
      { stage: "Manager Approval", reportCount: 0, overdueCount: 0 },
      { stage: "AP Review", reportCount: 1, overdueCount: 0 },
      { stage: "Paid", reportCount: 0, overdueCount: 0 },
      { stage: "Reconciled", reportCount: 0, overdueCount: 0 }
    ]);
  });

  it("rejects rows that violate the migrated Expense Report stage constraint", async () => {
    const invalidReport = {
      ...makeExpenseReport({ tenant_id: tenantA }),
      current_stage: "Archived" as ExpenseReportStage
    };

    await expect(insertExpenseReport(client, invalidReport)).rejects.toMatchObject({
      constraint: "expense_report_current_stage_check"
    });
  });

  it("does not store overdue as an expense_report column", async () => {
    const result = await client.query<{ column_name: string }>(
      `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'expense_report'
        and column_name = 'overdue';
      `
    );

    expect(result.rows).toEqual([]);
  });
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Case Queue integration tests.");
  }

  return process.env.DATABASE_URL;
}

function toCaseQueueExecutor(client: pg.Client): CaseQueueQueryExecutor {
  return {
    async query(sql: string, params: readonly [tenantId: string]) {
      const queryParams = sql.includes("$1") ? [...params] : [];
      const result = await client.query(sql, queryParams);

      return { rows: result.rows };
    }
  };
}

async function truncateDatabase(client: pg.Client): Promise<void> {
  await client.query(`
    truncate
        expense_report,
        expense_line_item,
        attachment_metadata,
        receipt,
        mileage_entry,
        audit_entry,
        stage_transition,
        comment
    restart identity cascade;
  `);
}

async function insertExpenseReport(client: pg.Client, report: ExpenseReportRow): Promise<void> {
  await client.query(
    `
    insert into expense_report (
      id,
      tenant_id,
      submitter_id,
      assigned_owner_id,
      manager_approver_id,
      ap_reviewer_id,
      payment_id,
      current_stage,
      priority,
      due_date,
      on_hold,
      hold_reason,
      created_at,
      updated_at
    ) values (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14
    );
    `,
    [
      report.id,
      report.tenant_id,
      report.submitter_id,
      report.assigned_owner_id,
      report.manager_approver_id,
      report.ap_reviewer_id,
      report.payment_id,
      report.current_stage,
      report.priority,
      report.due_date,
      report.on_hold,
      report.hold_reason,
      report.created_at,
      report.updated_at
    ]
  );
}
