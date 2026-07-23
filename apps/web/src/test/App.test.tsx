import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { authSessionStorageKey } from "../auth";
import { expenseReportStages } from "../domain";

const tenantId = "00000000-0000-4000-8000-000000000501";
const userId = "00000000-0000-4000-8000-000000000601";

describe("App", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders the sign-in form when unauthenticated", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tenant ID")).toBeInTheDocument();
    expect(screen.queryByLabelText("Expense Report workspace")).not.toBeInTheDocument();
  });

  it("completes sign-in through MFA and logs out through the hook", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createFetchResponse({
          status: "mfa_required",
          tenantId,
          userId,
          message: "MFA required."
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          status: "authenticated",
          tenantId,
          userId,
          roles: ["Finance Admin"],
          accessToken: createSyntheticJwt(300_000),
          refreshToken: "synthetic-refresh-token"
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await user.type(screen.getByLabelText("Tenant ID"), tenantId);
    await user.type(screen.getByLabelText("Email"), "synthetic.employee@example.test");
    await user.type(screen.getByLabelText("Password"), "synthetic-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByLabelText("MFA code")).toBeInTheDocument();

    await user.type(screen.getByLabelText("MFA code"), "123456");
    await user.click(screen.getByRole("button", { name: "Complete sign in" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Expense Report workspace")).toBeInTheDocument()
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/auth/login",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          email: "synthetic.employee@example.test",
          password: "synthetic-password"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/auth/mfa",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          userId,
          code: "123456"
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      })
    );
    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Current role view")).toHaveTextContent("Finance Admin");

    await user.click(screen.getByRole("button", { name: "Logout" }));

    expect(screen.getByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  it("composes the sidebar, metrics, stage stepper, and Expense Report table when restored", () => {
    window.sessionStorage.setItem(
      authSessionStorageKey,
      JSON.stringify({
        accessToken: createSyntheticJwt(300_000),
        refreshToken: "synthetic-refresh-token",
        tenantId,
        userId,
        roles: ["Finance Admin"]
      })
    );

    render(<App />);

    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Expense Reports" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open Reports" })).toBeInTheDocument();
    expect(screen.getByLabelText("Expense Report metrics")).toHaveTextContent("128");

    const stepper = screen.getByLabelText("Expense Report stage progress");

    for (const stage of expenseReportStages) {
      expect(within(stepper).getByText(stage)).toBeInTheDocument();
    }

    const table = screen.getByRole("table", { name: "Expense Report Cases" });

    expect(within(table).getByText("CASE-EF-2026-04-2241")).toBeInTheDocument();
  });
});

function createFetchResponse(body: object): Response {
  return {
    ok: true,
    json: async () => body
  } as Response;
}

function createSyntheticJwt(expiresInMs: number): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncode({
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    roles: ["Finance Admin"],
    sub: userId,
    tenantId
  });

  return `${header}.${payload}.synthetic-signature`;
}

function base64UrlEncode(value: object): string {
  return window
    .btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
