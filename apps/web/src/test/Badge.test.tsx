import { render, screen } from "@testing-library/react";
import { Badge } from "../atoms/Badge";

describe("Badge", () => {
  it("renders an Expense Report status stage", () => {
    render(<Badge kind="status" stage="Manager Approval" />);

    expect(screen.getByText("Manager Approval")).toBeInTheDocument();
  });

  it("renders an overdue SLA breach message", () => {
    render(<Badge kind="sla" label="Overdue" tone="breach" />);

    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("renders a priority label", () => {
    render(<Badge kind="priority" priority="Urgent" />);

    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });
});

