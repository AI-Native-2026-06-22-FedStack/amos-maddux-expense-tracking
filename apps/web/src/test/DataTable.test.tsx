import { render, screen, within } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "../components/DataTable";

interface TestRow {
  amount: string;
  caseId: string;
  submitter: string;
}

const columns: readonly DataTableColumn<TestRow>[] = [
  {
    header: "Case ID",
    key: "caseId",
    render: (row) => row.caseId,
  },
  {
    header: "Submitter",
    key: "submitter",
    render: (row) => row.submitter,
  },
  {
    header: "Amount",
    key: "amount",
    render: (row) => row.amount,
  },
];

const rows: readonly TestRow[] = [
  {
    amount: "$120.00",
    caseId: "CASE-EF-TEST-001",
    submitter: "Avery Stone",
  },
];

describe("DataTable", () => {
  it("renders typed column headers and row values", () => {
    render(<DataTable columns={columns} rows={rows} title="Expense Report Cases" />);

    const table = screen.getByRole("table");

    expect(screen.getByRole("heading", { name: "Expense Report Cases" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Case ID" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Submitter" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(within(table).getByText("CASE-EF-TEST-001")).toBeInTheDocument();
    expect(within(table).getByText("Avery Stone")).toBeInTheDocument();
    expect(within(table).getByText("$120.00")).toBeInTheDocument();
  });
});

