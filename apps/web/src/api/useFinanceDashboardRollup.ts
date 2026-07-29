import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useAuthSession } from "../auth";
import { expenseReportStages, type ExpenseReportStage, type UserRole } from "../domain";
import { useApiClient } from "./useApiClient";

export interface FinanceDashboardStageSummary {
  overdueCount: number;
  reportCount: number;
  stage: ExpenseReportStage;
}

export interface FinanceDashboardRollupResponse {
  summaries: readonly FinanceDashboardStageSummary[];
}

export type FinanceDashboardRollupQueryKey = readonly [
  "financeDashboardRollup",
  { readonly role: UserRole; readonly tenantId: string }
];

export interface UseFinanceDashboardRollupResult {
  query: UseQueryResult<FinanceDashboardRollupResponse, Error>;
  queryKey: FinanceDashboardRollupQueryKey;
}

export function financeDashboardRollupQueryKey(
  tenantId: string,
  role: UserRole
): FinanceDashboardRollupQueryKey {
  return ["financeDashboardRollup", { tenantId, role }];
}

export function useFinanceDashboardRollup(): UseFinanceDashboardRollupResult {
  const apiClient = useApiClient();
  const authSession = useAuthSession();
  const session = authSession.session;
  const tenantId = session?.tenantId ?? "";
  const role = session?.role ?? "Employee";
  const queryKey = financeDashboardRollupQueryKey(tenantId, role);

  const query = useQuery({
    enabled: session !== null,
    queryFn: async () =>
      parseFinanceDashboardRollupResponse(
        await apiClient.requestJson<unknown>("/expense-reports/case-queue/rollup")
      ),
    queryKey
  });

  return {
    query,
    queryKey
  };
}

function parseFinanceDashboardRollupResponse(value: unknown): FinanceDashboardRollupResponse {
  if (!isRecord(value) || !Array.isArray(value.summaries)) {
    throw new Error("Finance Dashboard rollup response was not valid.");
  }

  return {
    summaries: value.summaries.map(parseFinanceDashboardStageSummary)
  };
}

function parseFinanceDashboardStageSummary(value: unknown): FinanceDashboardStageSummary {
  if (!isRecord(value)) {
    throw new Error("Finance Dashboard rollup summary was not valid.");
  }

  const reportCount = value.reportCount;
  const overdueCount = value.overdueCount;

  if (
    !isExpenseReportStage(value.stage) ||
    typeof reportCount !== "number" ||
    !Number.isInteger(reportCount) ||
    reportCount < 0 ||
    typeof overdueCount !== "number" ||
    !Number.isInteger(overdueCount) ||
    overdueCount < 0
  ) {
    throw new Error("Finance Dashboard rollup summary was not valid.");
  }

  return {
    stage: value.stage,
    reportCount,
    overdueCount
  };
}

function isExpenseReportStage(value: unknown): value is ExpenseReportStage {
  return expenseReportStages.includes(value as ExpenseReportStage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
