import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistPanel } from "../components/AssistPanel";
import { createQueryAuthWrapper, createFetchResponse } from "./query-test-utils";

describe("AssistPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it("posts the policy question to the versioned assist endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createFetchResponse({
        answer: "Receipts are required above the general threshold.",
        citations: [
          {
            chunk_id: "NWP-POL-006-01",
            source: "data/corpus/006-receipt-and-documentation-policy.md",
            section_id: "NWP-POL-006-01",
            quote: null
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { wrapper } = createQueryAuthWrapper();
    render(<AssistPanel />, { wrapper });

    await user.type(screen.getByLabelText("Question"), "Do I need a receipt?");
    await user.click(screen.getByRole("button", { name: "Ask policy assist" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/assist",
      expect.objectContaining({
        body: JSON.stringify({ question: "Do I need a receipt?" }),
        method: "POST"
      })
    );
  });

  it("renders the answer and all returned citations together", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        createFetchResponse({
          answer: "Receipts are required above the general threshold.",
          citations: [
            {
              chunk_id: "NWP-POL-006-01",
              source: "data/corpus/006-receipt-and-documentation-policy.md",
              section_id: "NWP-POL-006-01",
              quote: "A receipt is required for any out-of-pocket expense."
            },
            {
              chunk_id: "NWP-POL-007-01",
              source: "https://expenseflow.example.test/policy/NWP-POL-007-01",
              section_id: "NWP-POL-007-01",
              quote: null
            }
          ]
        })
      )
    );
    const { wrapper } = createQueryAuthWrapper();
    render(<AssistPanel />, { wrapper });

    await user.type(screen.getByLabelText("Question"), "Do I need a receipt?");
    await user.click(screen.getByRole("button", { name: "Ask policy assist" }));

    expect(
      await screen.findByText("Receipts are required above the general threshold.")
    ).toBeInTheDocument();
    const citations = screen.getByLabelText("Policy citations");
    expect(within(citations).getByText("NWP-POL-006-01 (NWP-POL-006-01)")).toBeInTheDocument();
    expect(within(citations).getByText("NWP-POL-007-01 (NWP-POL-007-01)")).toBeInTheDocument();
    expect(
      within(citations).getByText("A receipt is required for any out-of-pocket expense.")
    ).toBeInTheDocument();
    expect(within(citations).getByRole("link", { name: /NWP-POL-007-01/u })).toHaveAttribute(
      "href",
      "https://expenseflow.example.test/policy/NWP-POL-007-01"
    );
  });

  it("renders an error state when the assist request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse(null, 500)));
    const { wrapper } = createQueryAuthWrapper();
    render(<AssistPanel />, { wrapper });

    await user.type(screen.getByLabelText("Question"), "Do I need a receipt?");
    await user.click(screen.getByRole("button", { name: "Ask policy assist" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 500.");
  });
});
