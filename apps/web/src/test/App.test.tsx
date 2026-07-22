import { render, screen } from "@testing-library/react";
import { App } from "../App";

describe("App shell", () => {
  it("renders the ExpenseFlow shell with sidebar and top bar", () => {
    render(<App />);

    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Expense Reports" })).toBeInTheDocument();
    expect(screen.getByLabelText("Current role view")).toHaveTextContent("Finance Admin");
  });
});
