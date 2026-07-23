import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { expenseReportStages, type ExpenseReportStage } from "../domain";
import { useStageStepper } from "../hooks/useStageStepper";

describe("useStageStepper", () => {
  it.each(expenseReportStages)("derives done/current/upcoming states for %s", (currentStage) => {
    const { result } = renderHook(() => useStageStepper({ currentStage }));
    const currentIndex = expenseReportStages.indexOf(currentStage);

    expect(result.current.currentStage).toBe(currentStage);
    expect(result.current.currentIndex).toBe(currentIndex);
    expect(result.current.isPaused).toBe(false);

    for (const step of result.current.steps) {
      if (step.index < currentIndex) {
        expect(step.state).toBe("done");
        expect(step.isCurrent).toBe(false);
      } else if (step.index === currentIndex) {
        expect(step.state).toBe("current");
        expect(step.isCurrent).toBe(true);
      } else {
        expect(step.state).toBe("upcoming");
        expect(step.isCurrent).toBe(false);
      }
    }
  });

  it("marks only the current step as paused when an Expense Report is on hold", () => {
    const { result } = renderHook(() =>
      useStageStepper({ currentStage: "AP Review", onHold: true })
    );

    expect(result.current.isPaused).toBe(true);
    expect(result.current.steps.filter((step) => step.isPaused)).toEqual([
      expect.objectContaining({
        stage: "AP Review",
        state: "current",
        isCurrent: true
      })
    ]);
  });

  it("resets correctly when a case moves backward to Drafted", () => {
    const { result } = renderHook(() => {
      const [currentStage, setCurrentStage] = useState<ExpenseReportStage>("Paid");
      const stepper = useStageStepper({ currentStage });

      return {
        setCurrentStage,
        stepper
      };
    });

    expect(result.current.stepper.currentStage).toBe("Paid");
    expect(result.current.stepper.steps.find((step) => step.stage === "AP Review")?.state).toBe(
      "done"
    );

    act(() => {
      result.current.setCurrentStage("Drafted");
    });

    expect(result.current.stepper.currentStage).toBe("Drafted");
    expect(result.current.stepper.steps[0]).toEqual(
      expect.objectContaining({
        stage: "Drafted",
        state: "current",
        isCurrent: true
      })
    );
    expect(result.current.stepper.steps.slice(1).every((step) => step.state === "upcoming")).toBe(
      true
    );
  });

  it("shares logic without sharing state between hook users", () => {
    const firstHook = renderHook(() => {
      const [currentStage, setCurrentStage] = useState<ExpenseReportStage>("Submitted");
      const stepper = useStageStepper({ currentStage });

      return {
        setCurrentStage,
        stepper
      };
    });
    const secondHook = renderHook(() => {
      const [currentStage, setCurrentStage] = useState<ExpenseReportStage>("AP Review");
      const stepper = useStageStepper({ currentStage });

      return {
        setCurrentStage,
        stepper
      };
    });

    act(() => {
      firstHook.result.current.setCurrentStage("Reconciled");
    });

    expect(firstHook.result.current.stepper.currentStage).toBe("Reconciled");
    expect(secondHook.result.current.stepper.currentStage).toBe("AP Review");
  });
});
