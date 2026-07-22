import { Badge } from "../atoms/Badge";
import { Button } from "../atoms/Button";
import { StageStepper } from "../atoms/StageStepper";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { MetricGrid, type MetricCard } from "../components/MetricGrid";
import type { ExpenseReportStage, Priority } from "../domain";
import styles from "./ExpenseReportsScreen.module.css";

interface SlaState {
  label: string;
  tone: "ok" | "warn" | "breach";
}

interface ExpenseReportRow {
  amount: string;
  caseId: string;
  due: SlaState | "none";
  priority: Priority;
  stage: ExpenseReportStage;
  submitter: string;
}

const metrics: readonly MetricCard[] = [
  {
    icon: "ER",
    label: "Open Reports",
    period: "$284,920 in flight",
    tone: "primary",
    value: "128",
  },
  {
    icon: "MA",
    label: "Awaiting Mgr Approval",
    period: "8 due today",
    tone: "warning",
    value: "42",
  },
  {
    change: {
      direction: "positive",
      label: "12.5%",
    },
    icon: "DA",
    label: "Deductible Amount",
    period: "vs last month",
    tone: "info",
    value: "$18,234",
  },
  {
    change: {
      direction: "negative",
      label: "8.2%",
    },
    icon: "OD",
    label: "Overdue",
    period: "Past due date",
    tone: "danger",
    value: "2",
  },
];

const expenseReports: readonly ExpenseReportRow[] = [
  {
    amount: "$2,841.30",
    caseId: "CASE-EF-2026-04-2241",
    due: { label: "18h", tone: "warn" },
    priority: "High",
    stage: "Manager Approval",
    submitter: "Riley Park",
  },
  {
    amount: "$5,612.40",
    caseId: "CASE-EF-2026-03-2191",
    due: { label: "Overdue", tone: "breach" },
    priority: "Urgent",
    stage: "Submitted",
    submitter: "Casey Reed",
  },
  {
    amount: "$4,200.00",
    caseId: "CASE-EF-2026-04-2240",
    due: { label: "2d 4h", tone: "ok" },
    priority: "Normal",
    stage: "AP Review",
    submitter: "Sam Rivera",
  },
  {
    amount: "$1,485.00",
    caseId: "CASE-EF-2026-03-2188",
    due: "none",
    priority: "Normal",
    stage: "Reconciled",
    submitter: "Jordan Lee",
  },
];

const columns: readonly DataTableColumn<ExpenseReportRow>[] = [
  {
    header: "Case ID",
    key: "caseId",
    render: (row) => <span className={styles.caseId}>{row.caseId}</span>,
  },
  {
    header: "Submitter",
    key: "submitter",
    render: (row) => <span className={styles.fontSemibold}>{row.submitter}</span>,
  },
  {
    header: "Stage",
    key: "stage",
    render: (row) => <Badge kind="status" stage={row.stage} />,
  },
  {
    header: "Amount",
    key: "amount",
    render: (row) => <span className={styles.fontSemibold}>{row.amount}</span>,
  },
  {
    header: "Priority",
    key: "priority",
    render: (row) => <Badge kind="priority" priority={row.priority} />,
  },
  {
    header: "Due",
    key: "due",
    render: (row) =>
      row.due === "none" ? (
        <Badge kind="neutral" label="-" />
      ) : (
        <Badge kind="sla" label={row.due.label} tone={row.due.tone} />
      ),
  },
  {
    header: "Actions",
    key: "actions",
    render: () => <Button variant="secondary">View</Button>,
  },
];

export function ExpenseReportsScreen() {
  return (
    <div>
      <MetricGrid metrics={metrics} />

      <section className={styles.stageCard} aria-labelledby="case-stage-title">
        <div className={styles.stageHeader}>
          <h2 className={styles.stageTitle} id="case-stage-title">
            Case stage (6 stages)
          </h2>
        </div>
        <div className={styles.stageBody}>
          <StageStepper currentStage="Manager Approval" />
        </div>
      </section>

      <DataTable
        actions={<Button variant="primary">Open Sample Case</Button>}
        columns={columns}
        rows={expenseReports}
        title="Expense Report Cases"
      />
    </div>
  );
}

