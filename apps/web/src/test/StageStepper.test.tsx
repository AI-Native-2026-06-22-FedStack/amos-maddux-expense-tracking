import { render, screen, within } from "@testing-library/react";
import { expenseReportStages } from "../domain";
import { StageStepper } from "../atoms/StageStepper";

describe("StageStepper", () => {
  it("renders all six Expense Report stages", () => {
    render(<StageStepper currentStage="Manager Approval" />);

    const stepper = screen.getByLabelText("Expense Report stage progress");

    for (const stage of expenseReportStages) {
      expect(within(stepper).getByText(stage)).toBeInTheDocument();
    }
  });

  it("marks the current stage with step semantics", () => {
    render(<StageStepper currentStage="AP Review" />);

    expect(screen.getByText("AP Review")).toHaveAttribute("aria-current", "step");
  });
});
