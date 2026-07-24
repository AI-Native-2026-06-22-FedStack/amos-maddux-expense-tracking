import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Sidebar, type SidebarPage } from "../components/Sidebar";
import type { UserRole } from "../domain";

const user = {
  initials: "MH",
  name: "Marcus Hill",
  organization: "Demo Tenant"
};

function renderSidebar(role: UserRole, activePage: SidebarPage = "expense-reports") {
  render(
    <MemoryRouter>
      <Sidebar activePage={activePage} caseCount={17} role={role} user={user} />
    </MemoryRouter>
  );

  return screen.getByLabelText("Primary navigation");
}

describe("Sidebar", () => {
  it("shows operator entries for Finance Admin and hides employee entries", () => {
    const navigation = renderSidebar("Finance Admin");

    expect(within(navigation).getByRole("link", { name: /Finance Dashboard/ })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: /Expense Reports/ })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: /Approval Queue/ })).toBeInTheDocument();
    expect(
      within(navigation).queryByRole("link", { name: /My Submissions/ })
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole("link", { name: /Submit Expense/ })
    ).not.toBeInTheDocument();
  });

  it("shows employee entries for Employee and hides operator entries", () => {
    const navigation = renderSidebar("Employee", "my-submissions");

    expect(within(navigation).getByRole("link", { name: /My Submissions/ })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: /Submit Expense/ })).toBeInTheDocument();
    expect(within(navigation).getByRole("link", { name: /Log Mileage/ })).toBeInTheDocument();
    expect(
      within(navigation).queryByRole("link", { name: /Finance Dashboard/ })
    ).not.toBeInTheDocument();
    expect(
      within(navigation).queryByRole("link", { name: /All Tenants & Users/ })
    ).not.toBeInTheDocument();
  });

  it("shows administration entries for Platform Admin", () => {
    const navigation = renderSidebar("Platform Admin", "admin-users");

    expect(
      within(navigation).getByRole("link", { name: /All Tenants & Users/ })
    ).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: /Roles & Permissions/ })
    ).toBeInTheDocument();
  });
});
