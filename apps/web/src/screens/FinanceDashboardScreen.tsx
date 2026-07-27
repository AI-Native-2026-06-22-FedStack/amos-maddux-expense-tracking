import { useMemo } from "react";
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Title,
  Tooltip,
  type ChartData,
  type ChartOptions
} from "chart.js";
import { Bar } from "react-chartjs-2";
import { EmptyState, ErrorState, LoadingState } from "../atoms/StateMessage";
import { expenseReportStages, type ExpenseReportStage } from "../domain";
import {
  useFinanceDashboardRollup,
  type FinanceDashboardStageSummary
} from "../api/useFinanceDashboardRollup";
import { ApiProblemError } from "../api";
import styles from "./FinanceDashboardScreen.module.css";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const stageColors = [
  "#2563eb",
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#15803d",
  "#be123c"
] as const;

export function FinanceDashboardScreen() {
  const { query } = useFinanceDashboardRollup();

  if (query.isPending) {
    return (
      <LoadingState
        title="Loading Finance Dashboard"
        message="Retrieving tenant-scoped Expense Report rollup data."
      />
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Finance Dashboard unavailable"
        message={readErrorMessage(query.error)}
        onRetry={() => {
          query.refetch().catch(() => undefined);
        }}
        retryLabel="Retry dashboard"
      />
    );
  }

  const summaries = orderSummaries(query.data.summaries);
  const overdueTotal = summaries.reduce((sum, row) => sum + row.overdueCount, 0);
  const reportTotal = summaries.reduce((sum, row) => sum + row.reportCount, 0);
  const isEmpty = reportTotal === 0 && overdueTotal === 0;

  if (isEmpty) {
    return (
      <main className={styles.dashboard} aria-labelledby="finance-dashboard-title">
        <section className={styles.summary}>
          <h1 className={styles.summaryTitle} id="finance-dashboard-title">
            Finance Dashboard
          </h1>
          <p className={styles.summaryText}>
            Tenant Expense Report metrics will appear when reports enter the rollup.
          </p>
        </section>
        <EmptyState
          title="No Expense Reports yet"
          message="There are no Expense Reports in this tenant rollup."
        />
      </main>
    );
  }

  return (
    <main className={styles.dashboard} aria-labelledby="finance-dashboard-title">
      <section className={styles.summary}>
        <h1 className={styles.summaryTitle} id="finance-dashboard-title">
          Finance Dashboard
        </h1>
        <p className={styles.summaryText}>
          {reportTotal} Expense Report{reportTotal === 1 ? "" : "s"} across tenant stages.{" "}
          {overdueTotal} overdue report{overdueTotal === 1 ? "" : "s"} need attention.
        </p>
      </section>

      <section className={styles.kpiGrid} aria-label="Expense Report stage KPIs">
        {summaries.map((summary) => (
          <KpiCard key={summary.stage} summary={summary} />
        ))}
        <article className={styles.kpiCard} aria-label="Overdue total">
          <p className={styles.kpiLabel}>Overdue total</p>
          <p className={styles.kpiValue}>{overdueTotal}</p>
          <p className={styles.kpiMeta}>Derived from due dates in the rollup.</p>
        </article>
      </section>

      <VolumeChart summaries={summaries} />
    </main>
  );
}

function KpiCard({ summary }: { summary: FinanceDashboardStageSummary }) {
  return (
    <article className={styles.kpiCard} aria-label={`${summary.stage} Expense Reports`}>
      <p className={styles.kpiLabel}>{summary.stage}</p>
      <p className={styles.kpiValue}>{summary.reportCount}</p>
      <p className={styles.kpiMeta}>
        {summary.overdueCount} overdue report{summary.overdueCount === 1 ? "" : "s"}
      </p>
    </article>
  );
}

function VolumeChart({ summaries }: { summaries: readonly FinanceDashboardStageSummary[] }) {
  const hasChartData = summaries.some((summary) => summary.reportCount > 0);
  const chartData = useMemo<ChartData<"bar", number[], string>>(
    () => ({
      labels: summaries.map((row) => row.stage),
      datasets: [
        {
          label: "Expense Report count",
          data: summaries.map((row) => row.reportCount),
          backgroundColor: summaries.map((_row, index) => stageColors[index % stageColors.length]),
          borderColor: "#1f2937",
          borderWidth: 1
        }
      ]
    }),
    [summaries]
  );

  const chartOptions = useMemo<ChartOptions<"bar">>(
    () => ({
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true
        },
        title: {
          display: true,
          text: "Expense Report volume by stage"
        },
        tooltip: {
          enabled: true
        }
      },
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0
          }
        }
      }
    }),
    []
  );

  if (!hasChartData) {
    return (
      <section className={styles.chartSection} aria-labelledby="finance-volume-title">
        <div className={styles.chartHeader}>
          <h2 className={styles.chartTitle} id="finance-volume-title">
            Expense Report volume by stage
          </h2>
        </div>
        <EmptyState
          title="No volume chart data"
          message="The rollup has no report counts to chart for this tenant."
        />
      </section>
    );
  }

  return (
    <section className={styles.chartSection} aria-labelledby="finance-volume-title">
      <div className={styles.chartHeader}>
        <h2 className={styles.chartTitle} id="finance-volume-title">
          Expense Report volume by stage
        </h2>
        <p className={styles.chartSummary}>
          Bars are labeled by stage, and the table below exposes the same report and overdue counts.
        </p>
      </div>
      <div className={styles.chartCanvas}>
        <Bar
          aria-label="Bar chart showing Expense Report volume by stage for this tenant."
          data={chartData}
          options={chartOptions}
        />
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <caption>Expense Report rollup data used by the volume chart</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">Report count</th>
              <th scope="col">Overdue count</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((summary) => (
              <tr key={summary.stage}>
                <td>{summary.stage}</td>
                <td>{summary.reportCount}</td>
                <td>{summary.overdueCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function orderSummaries(
  summaries: readonly FinanceDashboardStageSummary[]
): FinanceDashboardStageSummary[] {
  const summaryByStage = new Map(summaries.map((summary) => [summary.stage, summary]));

  return expenseReportStages.map(
    (stage) => summaryByStage.get(stage) ?? { stage, reportCount: 0, overdueCount: 0 }
  );
}

function readErrorMessage(error: Error): string {
  if (error instanceof ApiProblemError) {
    return error.detail;
  }

  return error.message;
}
