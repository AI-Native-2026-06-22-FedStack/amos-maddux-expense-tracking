import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { FinanceDashboardScreen } from "../screens/FinanceDashboardScreen";
import { createFetchResponse, createQueryAuthWrapper } from "./query-test-utils";

interface MockBarProps {
  "aria-label"?: string;
  data: {
    datasets: readonly {
      data?: unknown;
    }[];
    labels?: unknown;
  };
}

const barMock = vi.hoisted(() => vi.fn());

vi.mock("react-chartjs-2", () => ({
  Bar: (props: MockBarProps) => {
    barMock(props);

    return (
      <canvas
        aria-label={props["aria-label"]}
        data-chart-labels={JSON.stringify(props.data.labels)}
        data-chart-values={JSON.stringify(props.data.datasets[0]?.data)}
        data-testid="finance-dashboard-chart"
      />
    );
  }
}));

const populatedRollup = {
  summaries: [
    { stage: "Drafted", reportCount: 2, overdueCount: 1 },
    { stage: "Submitted", reportCount: 4, overdueCount: 0 },
    { stage: "Manager Approval", reportCount: 3, overdueCount: 2 },
    { stage: "AP Review", reportCount: 1, overdueCount: 0 },
    { stage: "Paid", reportCount: 5, overdueCount: 0 },
    { stage: "Reconciled", reportCount: 6, overdueCount: 0 }
  ]
} as const;

describe("FinanceDashboardScreen", () => {
  afterEach(() => {
    barMock.mockClear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders a loading state while the real rollup query is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined))
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<FinanceDashboardScreen />, { wrapper });

    expect(screen.getByRole("heading", { name: "Loading Finance Dashboard" })).toBeInTheDocument();
  });

  it("renders Problem JSON details when the rollup request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse(
          {
            type: "/problems/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Employee cannot read the Finance Dashboard rollup."
          },
          403
        )
      )
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<FinanceDashboardScreen />, { wrapper });

    expect(
      await screen.findByRole("heading", { name: "Finance Dashboard unavailable" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Employee cannot read the Finance Dashboard rollup.")
    ).toBeInTheDocument();
  });

  it("maps KPI cards, chart data, and the data table from the API rollup response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse(populatedRollup));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<FinanceDashboardScreen />, { wrapper });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Finance Dashboard" })
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/expense-reports/case-queue/rollup",
      expect.objectContaining({ method: "GET" })
    );

    expect(
      within(screen.getByLabelText("Drafted Expense Reports")).getByText("2")
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Manager Approval Expense Reports")).getByText("3")
    ).toBeInTheDocument();
    expect(within(screen.getByLabelText("Overdue total")).getByText("3")).toBeInTheDocument();

    const chart = screen.getByTestId("finance-dashboard-chart");
    expect(chart).toHaveAccessibleName(
      "Bar chart showing Expense Report volume by stage for this tenant."
    );
    expect(chart).toHaveAttribute(
      "data-chart-labels",
      JSON.stringify([
        "Drafted",
        "Submitted",
        "Manager Approval",
        "AP Review",
        "Paid",
        "Reconciled"
      ])
    );
    expect(chart).toHaveAttribute("data-chart-values", JSON.stringify([2, 4, 3, 1, 5, 6]));

    const table = screen.getByRole("table", {
      name: "Expense Report rollup data used by the volume chart"
    });
    expect(within(table).getByRole("columnheader", { name: "Stage" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "Manager Approval 3 2" })).toBeInTheDocument();
  });

  it("changes the chart when the synthetic rollup data changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse({
          summaries: [
            { stage: "Drafted", reportCount: 9, overdueCount: 0 },
            { stage: "Submitted", reportCount: 1, overdueCount: 0 }
          ]
        })
      )
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<FinanceDashboardScreen />, { wrapper });

    const chart = await screen.findByTestId("finance-dashboard-chart");
    expect(chart).toHaveAttribute("data-chart-values", JSON.stringify([9, 1, 0, 0, 0, 0]));
  });

  it("renders dashboard and chart empty states without rendering an empty canvas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse({
          summaries: [
            { stage: "Drafted", reportCount: 0, overdueCount: 0 },
            { stage: "Submitted", reportCount: 0, overdueCount: 0 },
            { stage: "Manager Approval", reportCount: 0, overdueCount: 0 },
            { stage: "AP Review", reportCount: 0, overdueCount: 0 },
            { stage: "Paid", reportCount: 0, overdueCount: 0 },
            { stage: "Reconciled", reportCount: 0, overdueCount: 0 }
          ]
        })
      )
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<FinanceDashboardScreen />, { wrapper });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Finance Dashboard" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No Expense Reports yet" })).toBeInTheDocument();
    expect(screen.queryByTestId("finance-dashboard-chart")).not.toBeInTheDocument();
  });

  it("keeps the dashboard screen and hook free of explicit any", async () => {
    const files = await Promise.all([
      readFile(resolve(__dirname, "../screens/FinanceDashboardScreen.tsx"), "utf8"),
      readFile(resolve(__dirname, "../api/useFinanceDashboardRollup.ts"), "utf8")
    ]);

    expect(files.join("\n")).not.toMatch(/\bany\b/u);
  });
});
