import { expenseReportStages, type ExpenseReportStage } from "../domain";
import styles from "./StageStepper.module.css";

export interface StageStepperProps {
  currentStage: ExpenseReportStage;
}

type StepState = "done" | "current" | "upcoming";

function getStepState(stage: ExpenseReportStage, currentStage: ExpenseReportStage): StepState {
  const stageIndex = expenseReportStages.indexOf(stage);
  const currentIndex = expenseReportStages.indexOf(currentStage);

  if (stageIndex < currentIndex) {
    return "done";
  }

  if (stageIndex === currentIndex) {
    return "current";
  }

  return "upcoming";
}

export function StageStepper({ currentStage }: StageStepperProps) {
  return (
    <ol className={styles.stageStepper} aria-label="Expense Report stage progress">
      {expenseReportStages.map((stage, index) => {
        const stepState = getStepState(stage, currentStage);

        return (
          <li className={styles.stageItem} key={stage}>
            <span
              className={`${styles.stageStep} ${styles[stepState]}`}
              aria-current={stepState === "current" ? "step" : undefined}
            >
              <span className={styles.stepDot} />
              {stage}
            </span>
            {index < expenseReportStages.length - 1 ? (
              <span className={styles.stageArrow} aria-hidden="true">
                &gt;
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
