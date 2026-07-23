import type { ExpenseReportStage, Priority } from "../domain";
import styles from "./Badge.module.css";

type StatusBadgeProps = {
  kind: "status";
  stage: ExpenseReportStage;
};

type SlaBadgeProps = {
  kind: "sla";
  label: string;
  tone: "ok" | "warn" | "breach";
};

type PriorityBadgeProps = {
  kind: "priority";
  priority: Priority;
};

type NeutralBadgeProps = {
  kind: "neutral";
  label: string;
};

export type BadgeProps = StatusBadgeProps | SlaBadgeProps | PriorityBadgeProps | NeutralBadgeProps;

const statusClassByStage: Record<ExpenseReportStage, string> = {
  Drafted: styles.neutral,
  Submitted: styles.info,
  "Manager Approval": styles.info,
  "AP Review": styles.info,
  Paid: styles.success,
  Reconciled: styles.success
};

const priorityClassByValue: Record<Priority, string> = {
  Urgent: styles.priorityUrgent,
  High: styles.priorityHigh,
  Normal: styles.priorityNormal,
  Low: styles.priorityLow
};

const slaLabelByTone: Record<SlaBadgeProps["tone"], string> = {
  ok: "SLA ok",
  warn: "SLA warning",
  breach: "SLA breach"
};

export function Badge(props: BadgeProps) {
  if (props.kind === "status") {
    return (
      <span className={`${styles.badge} ${statusClassByStage[props.stage]}`}>{props.stage}</span>
    );
  }

  if (props.kind === "sla") {
    return (
      <span
        aria-label={`${slaLabelByTone[props.tone]}: ${props.label}`}
        className={`${styles.slaBadge} ${styles[props.tone]}`}
        role="status"
      >
        {props.label}
      </span>
    );
  }

  if (props.kind === "priority") {
    return (
      <span className={`${styles.priority} ${priorityClassByValue[props.priority]}`}>
        {props.priority}
      </span>
    );
  }

  return <span className={`${styles.badge} ${styles.neutral}`}>{props.label}</span>;
}
