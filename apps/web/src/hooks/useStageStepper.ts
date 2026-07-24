import { useMemo } from "react";
import { expenseReportStages, type ExpenseReportStage } from "../domain";

export type StageStepState = "done" | "current" | "upcoming";

export interface UseStageStepperInput {
  currentStage: ExpenseReportStage;
  onHold?: boolean;
}

export interface StageStepperStep {
  stage: ExpenseReportStage;
  index: number;
  state: StageStepState;
  isCurrent: boolean;
  isPaused: boolean;
}

export interface UseStageStepperResult {
  steps: readonly StageStepperStep[];
  currentStage: ExpenseReportStage;
  currentIndex: number;
  isPaused: boolean;
}

export function useStageStepper({
  currentStage,
  onHold = false
}: UseStageStepperInput): UseStageStepperResult {
  return useMemo(() => {
    const currentIndex = expenseReportStages.indexOf(currentStage);
    const steps = expenseReportStages.map((stage, index): StageStepperStep => {
      const isCurrent = index === currentIndex;

      return {
        stage,
        index,
        state: getStepState(index, currentIndex),
        isCurrent,
        isPaused: onHold && isCurrent
      };
    });

    return {
      steps,
      currentStage,
      currentIndex,
      isPaused: onHold
    };
  }, [currentStage, onHold]);
}

function getStepState(stageIndex: number, currentIndex: number): StageStepState {
  if (stageIndex < currentIndex) {
    return "done";
  }

  if (stageIndex === currentIndex) {
    return "current";
  }

  return "upcoming";
}
