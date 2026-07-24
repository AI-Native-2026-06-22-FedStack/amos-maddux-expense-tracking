import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthSessionProvider, authSessionStorageKey, type AuthSessionStorage } from "../auth";
import { caseQueueQueryKey } from "../api/useCaseQueue";
import {
  createExpenseFlowMemoryRouter,
  ExpenseFlowRouterProvider,
  routePaths
} from "../routes/router";
import {
  createFetchResponse,
  createSession,
  createTestQueryClient,
  tenantId
} from "./query-test-utils";

describe("ExpenseFlow router", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("redirects unauthenticated users to the login route", async () => {
    renderRouter({ initialEntries: [routePaths.approvalQueue], session: null });

    expect(await screen.findByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
    expect(screen.queryByLabelText("ExpenseFlow navigation")).not.toBeInTheDocument();
  });

  it("keeps the shared shell while navigating between routed screens", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(createFetchResponse({ cases: [] }))
    );
    renderRouter({ initialEntries: [routePaths.expenseReports] });

    const navigation = await screen.findByLabelText("ExpenseFlow navigation");
    const roleView = screen.getByLabelText("Current role view");

    expect(screen.getByRole("heading", { name: "Expense Reports" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Approval Queue/u }));

    expect(await screen.findByRole("heading", { name: "Approval Queue" })).toBeInTheDocument();
    expect(screen.getByLabelText("ExpenseFlow navigation")).toBe(navigation);
    expect(screen.getByLabelText("Current role view")).toBe(roleView);
  });

  it("redirects authenticated users from login to the role default dashboard", async () => {
    renderRouter({ initialEntries: [routePaths.login] });

    expect(
      await screen.findByRole("heading", { level: 1, name: "Finance Dashboard" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
  });

  it("lands Employee users on the employee portal and blocks internal routes", async () => {
    renderRouter({
      initialEntries: [routePaths.approvalQueue],
      session: createSession("Employee")
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "My Submissions" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Approval Queue/u })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Submit Expense/u })).toBeInTheDocument();
  });

  it("renders route errors inside the shared shell", async () => {
    renderRouter({ initialEntries: ["/app/route-error-test"] });

    expect(await screen.findByRole("heading", { name: "Route unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Synthetic route failure.")).toBeInTheDocument();
    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Current role view")).toBeInTheDocument();
  });

  it("clears the query cache and session on logout", async () => {
    const user = userEvent.setup();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(caseQueueQueryKey(tenantId, "Finance Admin"), {
      cases: [
        {
          id: "00000000-0000-4000-8000-000000000701",
          currentStage: "Manager Approval",
          priority: "High",
          dueDate: null,
          onHold: false,
          updatedAt: "2026-07-24T12:00:00.000Z"
        }
      ]
    });

    renderRouter({ initialEntries: [routePaths.expenseReports], queryClient });

    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);

    await user.click(await screen.findByRole("button", { name: "Logout" }));

    await waitFor(() => expect(queryClient.getQueryCache().getAll()).toHaveLength(0));
    expect(screen.getByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });
});

interface RenderRouterOptions {
  initialEntries: readonly string[];
  queryClient?: ReturnType<typeof createTestQueryClient>;
  session?: ReturnType<typeof createSession> | null;
}

function renderRouter({
  initialEntries,
  queryClient = createTestQueryClient(),
  session = createSession()
}: RenderRouterOptions) {
  const storage = createMemoryStorage(session);
  const router = createExpenseFlowMemoryRouter(queryClient, initialEntries);

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthSessionProvider storage={storage}>
        <ExpenseFlowRouterProvider router={router} />
      </AuthSessionProvider>
    </QueryClientProvider>
  );
}

function createMemoryStorage(
  initialSession: ReturnType<typeof createSession> | null
): AuthSessionStorage {
  let storedSession = initialSession;

  return {
    clear: () => {
      storedSession = null;
      window.sessionStorage.removeItem(authSessionStorageKey);
    },
    load: () => storedSession,
    save: (session) => {
      storedSession = session;
      window.sessionStorage.setItem(authSessionStorageKey, JSON.stringify(session));
    }
  };
}
