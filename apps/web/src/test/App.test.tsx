import { render, screen, within } from "@testing-library/react";
import { App } from "../App";
import { expenseReportStages } from "../domain";

describe("App", () => {
  it("composes the sidebar, metrics, stage stepper, and Expense Report table", () => {
    render(<App />);

    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Expense Reports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open Reports" })).toBeInTheDocument();
    expect(screen.getByLabelText("Expense Report metrics")).toHaveTextContent("128");

    const stepper = screen.getByLabelText("Expense Report stage progress");

    for (const stage of expenseReportStages) {
      expect(within(stepper).getByText(stage)).toBeInTheDocument();
    }

    const table = screen.getByRole("table", { name: "Expense Report Cases" });

    expect(within(table).getByText("CASE-EF-2026-04-2241")).toBeInTheDocument();
  });
});
