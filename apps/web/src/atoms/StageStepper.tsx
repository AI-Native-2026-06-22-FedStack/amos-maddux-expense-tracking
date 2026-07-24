import { expenseReportStages, type ExpenseReportStage } from "../domain";
import { useStageStepper } from "../hooks/useStageStepper";
import styles from "./StageStepper.module.css";

export interface StageStepperProps {
  currentStage: ExpenseReportStage;
  onHold?: boolean;
}

export function StageStepper({ currentStage, onHold = false }: StageStepperProps) {
  const stageStepper = useStageStepper({ currentStage, onHold });

  return (
    <ol className={styles.stageStepper} aria-label="Expense Report stage progress">
      {stageStepper.steps.map((step) => (
        <li className={styles.stageItem} key={step.stage}>
          <span
            className={`${styles.stageStep} ${styles[step.state]} ${
              step.isPaused ? styles.paused : ""
            }`}
            aria-current={step.isCurrent ? "step" : undefined}
          >
            <span className={styles.stepDot} />
            {step.stage}
            {step.isPaused ? (
              <span aria-label="On hold" className={styles.pausedIndicator} role="status">
                On hold
              </span>
            ) : null}
          </span>
          {step.index < expenseReportStages.length - 1 ? (
            <span className={styles.stageArrow} aria-hidden="true">
              &gt;
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
