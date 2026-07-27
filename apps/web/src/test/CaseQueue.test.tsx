import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseQueue } from "../screens/CaseQueue";
import { createFetchResponse, createQueryAuthWrapper } from "./query-test-utils";

const queueCase = {
  id: "00000000-0000-4000-8000-000000000701",
  currentStage: "Manager Approval",
  priority: "High",
  dueDate: "2026-07-28",
  onHold: false,
  updatedAt: "2026-07-24T12:00:00.000Z"
} as const;

describe("CaseQueue", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders the loading state", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined))
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(screen.getByRole("heading", { name: "Loading Case Queue" })).toBeInTheDocument();
    expect(screen.getByText("Retrieving tenant-scoped Expense Report cases.")).toBeInTheDocument();
  });

  it("renders the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ cases: [] }))
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(
      await screen.findByRole("heading", { name: "No cases in the queue" })
    ).toBeInTheDocument();
  });

  it("renders typed error details and retries the query", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createFetchResponse(
          {
            type: "/problems/synthetic-case-queue",
            title: "Synthetic Queue Failure",
            status: 503,
            detail: "Synthetic typed queue error.",
            instance: "/v1/expense-reports/case-queue"
          },
          503
        )
      )
      .mockResolvedValueOnce(createFetchResponse({ cases: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Synthetic typed queue error.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry queue" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", { name: "No cases in the queue" })
    ).toBeInTheDocument();
  });

  it("renders queue rows and advances a case without a manual reload", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ cases: [queueCase] }))
      .mockResolvedValueOnce(createFetchResponse({ ...queueCase, currentStage: "AP Review" }))
      .mockResolvedValueOnce(
        createFetchResponse({ cases: [{ ...queueCase, currentStage: "AP Review" }] })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByRole("table", { name: "Case Queue" })).toBeInTheDocument();
    expect(screen.getByText("Manager Approval")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advance" }));

    expect(await screen.findByText("AP Review")).toBeInTheDocument();
  });

  it("renders date-only due dates without shifting calendar days", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ cases: [queueCase] }))
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Jul 28, 2026")).toBeInTheDocument();
  });

  it("disables advance for non-actionable stages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse({
          cases: [{ ...queueCase, currentStage: "Paid" }]
        })
      )
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByRole("button", { name: "Advance" })).toBeDisabled();
  });
});
