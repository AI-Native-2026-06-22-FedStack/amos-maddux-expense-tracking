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

  it.each(expenseReportStages)("marks %s as the current stage with step semantics", (stage) => {
    render(<StageStepper currentStage={stage} />);

    expect(screen.getByText(stage)).toHaveAttribute("aria-current", "step");
  });

  it("shows an on-hold paused indicator without losing the current stage position", () => {
    render(<StageStepper currentStage="AP Review" onHold />);

    expect(screen.getByRole("status", { name: "On hold" })).toBeInTheDocument();
    expect(screen.getByText("AP Review")).toHaveAttribute("aria-current", "step");
  });
});
