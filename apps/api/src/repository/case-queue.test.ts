import { describe, expect, it } from "vitest";

import {
  CaseQueueQueryExecutor,
  CaseQueueQueryResult,
  caseQueueSql,
  expenseReportStages,
  readCaseQueue
} from "./case-queue.js";

class RecordingCaseQueueExecutor implements CaseQueueQueryExecutor {
  public sql = "";
  public params: readonly [tenantId: string] | undefined;

  public constructor(private readonly result: CaseQueueQueryResult) {}

  public async query(
    sql: string,
    params: readonly [tenantId: string]
  ): Promise<CaseQueueQueryResult> {
    this.sql = sql;
    this.params = params;

    return this.result;
  }
}

describe("readCaseQueue", () => {
  it("runs a single tenant-scoped Case Queue read", async () => {
    const tenantId = "00000000-0000-4000-8000-000000000101";
    const executor = new RecordingCaseQueueExecutor({
      rows: [
        { stage: "Drafted", report_count: 2, overdue_count: 1 },
        { stage: "Submitted", report_count: 0, overdue_count: 0 },
        { stage: "Manager Approval", report_count: 4, overdue_count: 2 },
        { stage: "AP Review", report_count: 1, overdue_count: 0 },
        { stage: "Paid", report_count: 3, overdue_count: 0 },
        { stage: "Reconciled", report_count: 5, overdue_count: 0 }
      ]
    });

    const summaries = await readCaseQueue(executor, tenantId);

    expect(executor.params).toEqual([tenantId]);
    expect(summaries).toEqual([
      { stage: "Drafted", reportCount: 2, overdueCount: 1 },
      { stage: "Submitted", reportCount: 0, overdueCount: 0 },
      { stage: "Manager Approval", reportCount: 4, overdueCount: 2 },
      { stage: "AP Review", reportCount: 1, overdueCount: 0 },
      { stage: "Paid", reportCount: 3, overdueCount: 0 },
      { stage: "Reconciled", reportCount: 5, overdueCount: 0 }
    ]);
  });

  it("expresses every canonical stage through a CTE and left join", () => {
    expect(caseQueueSql).toContain("with canonical_stages(stage, sort_order) as");
    expect(caseQueueSql).toContain("left join stage_counts");

    for (const stage of expenseReportStages) {
      expect(caseQueueSql).toContain(`'${stage}'`);
    }
  });

  it("derives overdue counts at read time and filters by tenant", () => {
    expect(caseQueueSql).toContain("count(*) filter (where due_date < current_date)::integer");
    expect(caseQueueSql).toContain("from expense_report");
    expect(caseQueueSql).toContain("where tenant_id = $1");
    expect(caseQueueSql).toContain("group by current_stage");
  });

  it("maps null database counts to numeric zeros", async () => {
    const executor = new RecordingCaseQueueExecutor({
      rows: [{ stage: "Drafted", report_count: null, overdue_count: null }]
    });

    const summaries = await readCaseQueue(executor, "00000000-0000-4000-8000-000000000102");

    expect(summaries).toEqual([{ stage: "Drafted", reportCount: 0, overdueCount: 0 }]);
  });

  it("requires a tenant id", async () => {
    const executor = new RecordingCaseQueueExecutor({ rows: [] });

    await expect(readCaseQueue(executor, " ")).rejects.toThrow(
      "tenant_id is required to read the Case Queue."
    );
  });
});
