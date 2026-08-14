import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createExpenseDraftExpenseReportRequestSchema,
  createMileageDraftExpenseReportRequestSchema
} from "@expenseflow/shared-schemas";
import { caseQueueQueryKey } from "../api/useCaseQueue";
import { LogMileageScreen } from "../screens/LogMileageScreen";
import { SubmitExpenseScreen } from "../screens/SubmitExpenseScreen";
import {
  createFetchResponse,
  createQueryAuthWrapper,
  createSession,
  createTestQueryClient,
  tenantId
} from "./query-test-utils";

describe("Expense write forms", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("submits a valid mileage draft through the shared contract and invalidates the queue key", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createFetchResponse({
        currentStage: "Drafted",
        dueDate: "2026-08-03",
        id: "00000000-0000-4000-8000-000000000701",
        priority: "Normal",
        tenantId,
        updatedAt: "2026-08-03T12:00:00.000Z"
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { wrapper } = createQueryAuthWrapper(queryClient, createSession("Employee"));

    render(<LogMileageScreen />, { wrapper });

    await user.type(screen.getByLabelText("Due date"), "2026-08-03");
    await user.type(screen.getByLabelText("Trip date"), "2026-08-01");
    await user.type(screen.getByLabelText("Origin"), "Synthetic Origin Office");
    await user.type(screen.getByLabelText("Destination"), "Synthetic Destination Office");
    await user.clear(screen.getByLabelText("Miles"));
    await user.type(screen.getByLabelText("Miles"), "18.25");
    await user.type(screen.getByLabelText("Business purpose"), "Synthetic client support visit.");
    await user.click(screen.getByRole("button", { name: "Save mileage draft" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = readRequestBody(fetchMock);
    expect(createMileageDraftExpenseReportRequestSchema.safeParse(payload).success).toBe(true);
    expect(payload).toEqual({
      draftType: "mileage",
      dueDate: "2026-08-03",
      mileageEntries: [
        {
          business_purpose: "Synthetic client support visit.",
          destination: "Synthetic Destination Office",
          miles: 18.25,
          origin: "Synthetic Origin Office",
          trip_date: "2026-08-01"
        }
      ],
      priority: "Normal"
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: caseQueueQueryKey(tenantId, "Employee")
      })
    );
    expect(await screen.findByText("Mileage draft saved.")).toBeInTheDocument();
  });

  it("blocks invalid mileage input with described field errors before calling the API", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper(createTestQueryClient(), createSession("Employee"));

    render(<LogMileageScreen />, { wrapper });

    await user.clear(screen.getByLabelText("Miles"));
    await user.type(screen.getByLabelText("Miles"), "0");
    await user.click(screen.getByRole("button", { name: "Save mileage draft" }));

    expect(await screen.findByText("Origin is required.")).toBeInTheDocument();
    const origin = screen.getByLabelText("Origin");
    expect(origin).toHaveAccessibleDescription("Origin is required.");
    expect(origin).toHaveAttribute("aria-describedby", "mileage-origin-error");
    expect(screen.getByLabelText("Miles")).toHaveAccessibleDescription(
      "Miles must be greater than 0."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a valid expense draft with receipt metadata through the shared contract", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createFetchResponse({
        currentStage: "Drafted",
        dueDate: "2026-08-05",
        id: "00000000-0000-4000-8000-000000000702",
        priority: "High",
        tenantId,
        updatedAt: "2026-08-05T12:00:00.000Z"
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const { wrapper } = createQueryAuthWrapper(queryClient, createSession("Employee"));

    render(<SubmitExpenseScreen />, { wrapper });

    await user.selectOptions(screen.getByLabelText("Priority"), "High");
    await user.type(screen.getByLabelText("Due date"), "2026-08-05");
    await user.type(screen.getByLabelText("Merchant"), "Synthetic Cafe");
    await user.clear(screen.getByLabelText("Amount in cents"));
    await user.type(screen.getByLabelText("Amount in cents"), "4250");
    await user.type(screen.getByLabelText("Category"), "Meals");
    await user.type(screen.getByLabelText("Receipt merchant"), "Synthetic Cafe");
    await user.clear(screen.getByLabelText("Receipt amount in cents"));
    await user.type(screen.getByLabelText("Receipt amount in cents"), "4250");
    await user.type(screen.getByLabelText("Receipt date"), "2026-08-02");
    await user.type(screen.getByLabelText("Receipt number"), "SYN-4250");
    await user.click(screen.getByRole("button", { name: "Save expense draft" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = readRequestBody(fetchMock);
    expect(createExpenseDraftExpenseReportRequestSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      draftType: "expense",
      dueDate: "2026-08-05",
      lineItems: [
        {
          amount_cents: 4250,
          category: "Meals",
          currency: "USD",
          merchant: "Synthetic Cafe",
          receipt: {
            amount_cents: 4250,
            currency: "USD",
            merchant: "Synthetic Cafe",
            receipt_date: "2026-08-02",
            receipt_number: "SYN-4250"
          }
        }
      ],
      priority: "High"
    });
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: caseQueueQueryKey(tenantId, "Employee")
      })
    );
    expect(await screen.findByText("Expense draft saved.")).toBeInTheDocument();
  });

  it("blocks invalid expense input and exposes receipt errors by description", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper(createTestQueryClient(), createSession("Employee"));

    render(<SubmitExpenseScreen />, { wrapper });

    await user.clear(screen.getByLabelText("Amount in cents"));
    await user.type(screen.getByLabelText("Amount in cents"), "0");
    await user.clear(screen.getByLabelText("Receipt currency"));
    await user.type(screen.getByLabelText("Receipt currency"), "usd");
    await user.click(screen.getByRole("button", { name: "Save expense draft" }));

    expect(await screen.findByText("Merchant is required.")).toBeInTheDocument();
    expect(screen.getByLabelText("Merchant")).toHaveAccessibleDescription("Merchant is required.");
    expect(screen.getByLabelText("Amount in cents")).toHaveAccessibleDescription(
      "Amount must be greater than 0."
    );
    expect(screen.getByLabelText("Receipt currency")).toHaveAccessibleDescription(
      "Use a three-letter uppercase currency code."
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders API Problem JSON failures without reporting success", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse(
          {
            type: "/problems/synthetic-write",
            title: "Synthetic Write Failure",
            status: 409,
            detail: "Synthetic draft could not be saved.",
            instance: "/v1/expense-reports"
          },
          409
        )
      )
    );
    const { wrapper } = createQueryAuthWrapper(createTestQueryClient(), createSession("Employee"));

    render(<LogMileageScreen />, { wrapper });

    await user.type(screen.getByLabelText("Trip date"), "2026-08-01");
    await user.type(screen.getByLabelText("Origin"), "Synthetic Origin Office");
    await user.type(screen.getByLabelText("Destination"), "Synthetic Destination Office");
    await user.clear(screen.getByLabelText("Miles"));
    await user.type(screen.getByLabelText("Miles"), "18.25");
    await user.type(screen.getByLabelText("Business purpose"), "Synthetic client support visit.");
    await user.click(screen.getByRole("button", { name: "Save mileage draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Synthetic draft could not be saved."
    );
    expect(screen.queryByText("Mileage draft saved.")).not.toBeInTheDocument();
  });

  it("keeps the mileage form keyboard operable in label order", async () => {
    const user = userEvent.setup();
    const { wrapper } = createQueryAuthWrapper(createTestQueryClient(), createSession("Employee"));

    render(<LogMileageScreen />, { wrapper });

    await user.tab();
    expect(screen.getByLabelText("Priority")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Due date")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Trip date")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Origin")).toHaveFocus();
  });

  it("does not declare local zod object schemas in form or API client files", () => {
    const formSources = [
      readFileSync(join(process.cwd(), "src/screens/LogMileageScreen.tsx"), "utf8"),
      readFileSync(join(process.cwd(), "src/screens/SubmitExpenseScreen.tsx"), "utf8"),
      readFileSync(join(process.cwd(), "src/api/useExpenseDraftMutations.ts"), "utf8")
    ].join("\n");

    expect(formSources).not.toMatch(/z\.object/u);
  });
});

function readRequestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): unknown {
  const requestInit = fetchMock.mock.calls[0]?.[1];

  if (requestInit === undefined || typeof requestInit.body !== "string") {
    throw new Error("Expected a JSON request body.");
  }

  return JSON.parse(requestInit.body) as unknown;
}
