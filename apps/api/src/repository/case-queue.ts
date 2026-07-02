export const expenseReportStages = [
  "Drafted",
  "Submitted",
  "Manager Approval",
  "AP Review",
  "Paid",
  "Reconciled"
] as const;

export type ExpenseReportStage = (typeof expenseReportStages)[number];

export interface CaseQueueStageSummary {
  stage: ExpenseReportStage;
  reportCount: number;
  overdueCount: number;
}

export interface CaseQueueQueryResult {
  rows: readonly CaseQueueRow[];
}

export interface CaseQueueQueryExecutor {
  query(sql: string, params: readonly [tenantId: string]): Promise<CaseQueueQueryResult>;
}

interface CaseQueueRow {
  stage: ExpenseReportStage;
  report_count: number | string | null;
  overdue_count: number | string | null;
}

export const caseQueueSql = `
with canonical_stages(stage, sort_order) as (
    values
        ('Drafted', 1),
        ('Submitted', 2),
        ('Manager Approval', 3),
        ('AP Review', 4),
        ('Paid', 5),
        ('Reconciled', 6)
),
stage_counts as (
    select
        current_stage as stage,
        count(*)::integer as report_count,
        count(*) filter (where due_date < now())::integer as overdue_count
    from expense_report
    where tenant_id = $1
    group by current_stage
)
select
    canonical_stages.stage,
    coalesce(stage_counts.report_count, 0) as report_count,
    coalesce(stage_counts.overdue_count, 0) as overdue_count
from canonical_stages
left join stage_counts on stage_counts.stage = canonical_stages.stage
order by canonical_stages.sort_order;
`;

export async function readCaseQueue(
  executor: CaseQueueQueryExecutor,
  tenantId: string
): Promise<readonly CaseQueueStageSummary[]> {
  if (tenantId.trim().length === 0) {
    throw new Error("tenant_id is required to read the Case Queue.");
  }

  const result = await executor.query(caseQueueSql, [tenantId]);

  return result.rows.map((row) => ({
    stage: row.stage,
    reportCount: parseDatabaseCount(row.report_count),
    overdueCount: parseDatabaseCount(row.overdue_count)
  }));
}

function parseDatabaseCount(value: number | string | null): number {
  if (value === null) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  return Number.parseInt(value, 10);
}
