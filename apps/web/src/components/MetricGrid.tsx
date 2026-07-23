import styles from "./MetricGrid.module.css";

export type MetricTone = "primary" | "warning" | "info" | "danger";

export interface MetricCard {
  change?: {
    direction: "positive" | "negative";
    label: string;
  };
  icon: string;
  label: string;
  period: string;
  tone: MetricTone;
  value: string;
}

export interface MetricGridProps {
  metrics: readonly MetricCard[];
}

export function MetricGrid({ metrics }: MetricGridProps) {
  return (
    <section className={styles.kpiGrid} aria-label="Expense Report metrics">
      {metrics.map((metric) => (
        <article className={styles.kpiCard} key={metric.label}>
          <div className={styles.kpiHeader}>
            <h2 className={styles.kpiLabel}>{metric.label}</h2>
            <div className={`${styles.kpiIcon} ${styles[metric.tone]}`} aria-hidden="true">
              {metric.icon}
            </div>
          </div>
          <div className={styles.kpiValue}>{metric.value}</div>
          <div className={styles.kpiFooter}>
            {metric.change ? (
              <div className={`${styles.kpiChange} ${styles[metric.change.direction]}`}>
                <span aria-hidden="true">{metric.change.direction === "positive" ? "^" : "v"}</span>
                <span>{metric.change.label}</span>
              </div>
            ) : null}
            <div className={styles.kpiPeriod}>{metric.period}</div>
          </div>
        </article>
      ))}
    </section>
  );
}
