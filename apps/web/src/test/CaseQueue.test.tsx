import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaseQueue } from "../screens/CaseQueue";
import { approvalQueueQueryKey, type ApprovalQueueResponse } from "../api/useApprovalQueue";
import {
  createFetchResponse,
  createQueryAuthWrapper,
  tenantId
} from "./query-test-utils";

const managerReportId = "00000000-0000-4000-8000-000000000701";
const apReportId = "00000000-0000-4000-8000-000000000702";

const managerLineItem = {
  reportId: managerReportId,
  reportStage: "Manager Approval",
  lineItemId: "00000000-0000-4000-8000-000000000711",
  merchant: "Synthetic Bravo Cafe",
  amountCents: 72500,
  currency: "USD",
  category: "Meals",
  flagged: true,
  flagCleared: false,
  glCodingStatus: "mapped",
  glCodeId: "00000000-0000-4000-8000-000000000721",
  glAccountCode: "6100",
  glAccountName: "Synthetic Meals Expense",
  deductible: false,
  managerReviewStatus: "pending",
  createdAt: "2026-07-21T12:00:00.000Z"
} as const;

const apLineItem = {
  reportId: apReportId,
  reportStage: "AP Review",
  lineItemId: "00000000-0000-4000-8000-000000000712",
  merchant: "Synthetic Alpha Supplies",
  amountCents: 1845,
  currency: "USD",
  category: "Supplies",
  flagged: false,
  flagCleared: false,
  glCodingStatus: "mapped",
  glCodeId: "00000000-0000-4000-8000-000000000722",
  glAccountCode: "6200",
  glAccountName: "Synthetic Supplies Expense",
  deductible: false,
  managerReviewStatus: "pending",
  createdAt: "2026-07-22T12:00:00.000Z"
} as const;

describe("CaseQueue Approval Queue table", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders semantic table markup with sortable headers and text flag status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ lineItems: [managerLineItem] }))
    );
    const { wrapper } = createQueryAuthWrapper(undefined, undefined);

    render(<CaseQueue />, { wrapper });

    const table = await screen.findByRole("table", {
      name: "Department Manager approval line items"
    });

    expect(table.tagName).toBe("TABLE");
    expect(table.querySelector("thead")).not.toBeNull();
    expect(table.querySelector("tbody")).not.toBeNull();
    expect(table.querySelectorAll('th[scope="col"]')).toHaveLength(8);
    expect(table.querySelector(":scope > div")).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Merchant" })).toHaveAttribute(
      "aria-sort",
      "none"
    );
    expect(screen.getByText("Flagged over $500")).toBeInTheDocument();
  });

  it("sorts, filters, and paginates through TanStack row models", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse({
          lineItems: createManyLineItems()
        })
      )
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Synthetic Bravo Cafe")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Merchant" }));
    expect(screen.getByRole("columnheader", { name: "Merchant" })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
    expect(firstBodyRowText()).toContain("Synthetic Alpha Supplies");

    await user.type(screen.getByLabelText("Filter line items"), "Vendor 10");
    expect(screen.getByText("Synthetic Vendor 10")).toBeInTheDocument();
    expect(screen.queryByText("Synthetic Vendor 03")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Filter line items"));
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("Synthetic Vendor 10")).toBeInTheDocument();
  });

  it("optimistically approves and clears flags, then invalidates the exact query key", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [managerLineItem] }))
      .mockResolvedValueOnce(
        createFetchResponse({ ...managerLineItem, managerReviewStatus: "approved" })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          lineItems: [{ ...managerLineItem, managerReviewStatus: "approved" }]
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          ...managerLineItem,
          flagCleared: true,
          managerReviewStatus: "approved"
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          lineItems: [
            {
              ...managerLineItem,
              flagCleared: true,
              managerReviewStatus: "approved"
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { queryClient, wrapper } = createQueryAuthWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve Synthetic Bravo Cafe" }));
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: approvalQueueQueryKey(tenantId, "Finance Admin")
      })
    );

    await user.click(screen.getByRole("button", { name: "Clear flag for Synthetic Bravo Cafe" }));
    expect(await screen.findByText("Flag cleared")).toBeInTheDocument();
  });

  it("rolls back optimistic row action changes when the API fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [managerLineItem] }))
      .mockResolvedValueOnce(
        createFetchResponse(
          {
            type: "/problems/synthetic-approval",
            title: "Synthetic Approval Failure",
            status: 503,
            detail: "Synthetic approval write failed.",
            instance: `/v1/expense-reports/${managerReportId}/line-items/${managerLineItem.lineItemId}/approve`
          },
          503
        )
      )
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [managerLineItem] }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Pending")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve Synthetic Bravo Cafe" }));

    expect(await screen.findByText("Synthetic approval write failed.")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
  });

  it("persists deductible only in AP Review and disables the checkbox outside AP Review", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [managerLineItem, apLineItem] }))
      .mockResolvedValueOnce(createFetchResponse({ ...apLineItem, deductible: true }))
      .mockResolvedValueOnce(
        createFetchResponse({ lineItems: [managerLineItem, { ...apLineItem, deductible: true }] })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Synthetic Alpha Supplies")).toBeInTheDocument();

    const managerCheckbox = screen.getByLabelText("Deductible, read-only outside AP Review");
    const apCheckbox = screen.getByLabelText("Deductible");

    expect(managerCheckbox).toBeDisabled();
    await user.click(apCheckbox);
    await waitFor(() => expect(screen.getByLabelText("Deductible")).toBeChecked());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/v1/expense-reports/${apReportId}/line-items/${apLineItem.lineItemId}/deductible`,
        expect.objectContaining({ method: "PATCH" })
      )
    );
  });

  it("requires a send-back reason and submits valid report-level send-back", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [managerLineItem] }))
      .mockResolvedValueOnce(createFetchResponse({ currentStage: "Drafted" }))
      .mockResolvedValueOnce(createFetchResponse({ lineItems: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByText("Synthetic Bravo Cafe")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Send report ${managerReportId.slice(0, 8)} back` }));
    await user.click(screen.getByRole("button", { name: "Send back to Drafted" }));

    expect(screen.getByText("Enter a reason before sending this report back.")).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(`Reason for sending report ${managerReportId.slice(0, 8)} back to Drafted`),
      "Synthetic receipt needs detail."
    );
    await user.click(screen.getByRole("button", { name: "Send back to Drafted" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/v1/expense-reports/${managerReportId}/reject`,
        expect.objectContaining({
          body: JSON.stringify({ reason: "Synthetic receipt needs detail." }),
          method: "POST"
        })
      )
    );
  });

  it("is keyboard operable through table controls", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ lineItems: [managerLineItem] }))
    );
    const { wrapper } = createQueryAuthWrapper();

    render(<CaseQueue />, { wrapper });

    expect(await screen.findByRole("table")).toBeInTheDocument();

    await user.tab();
    expect(screen.getByLabelText("Filter line items")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Merchant" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Amount" })).toHaveFocus();
  });

  it("keeps the queue table and API hook free of explicit any", async () => {
    const files = [
      resolve(import.meta.dirname, "../screens/CaseQueue.tsx"),
      resolve(import.meta.dirname, "../api/useApprovalQueue.ts")
    ];
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));

    for (const content of contents) {
      expect(content).not.toMatch(/\bany\b/u);
    }
  });
});

function firstBodyRowText(): string {
  const table = screen.getByRole("table", { name: "Department Manager approval line items" });
  const rows = within(table).getAllByRole("row");

  return rows[1]?.textContent ?? "";
}

function createManyLineItems(): ApprovalQueueResponse["lineItems"] {
  return [
    managerLineItem,
    apLineItem,
    ...Array.from({ length: 9 }, (_value, index) => ({
      ...managerLineItem,
      reportId: `00000000-0000-4000-8000-0000000008${index.toString().padStart(2, "0")}`,
      lineItemId: `00000000-0000-4000-8000-0000000009${index.toString().padStart(2, "0")}`,
      merchant: `Synthetic Vendor ${(index + 2).toString().padStart(2, "0")}`,
      amountCents: 3000 + index,
      flagged: false,
      flagCleared: false
    }))
  ];
}
