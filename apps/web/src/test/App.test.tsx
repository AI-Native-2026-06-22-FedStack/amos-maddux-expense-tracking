import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { authSessionStorageKey } from "../auth";
import { expenseReportStages } from "../domain";

const tenantId = "00000000-0000-4000-8000-000000000501";
const userId = "00000000-0000-4000-8000-000000000601";

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders the sign-in form when unauthenticated", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
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

    await user.type(await screen.findByLabelText("Tenant ID"), tenantId);
    await user.type(screen.getByLabelText("Email"), "synthetic.employee@example.test");
    await user.type(screen.getByLabelText("Password"), "synthetic-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByLabelText("MFA code")).toBeInTheDocument();

    await user.type(screen.getByLabelText("MFA code"), "123456");
    await user.click(screen.getByRole("button", { name: "Complete sign in" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Finance Dashboard" })
    ).toBeInTheDocument();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/auth/login",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          email: "synthetic.employee@example.test",
          password: "synthetic-password"
        }),
        method: "POST"
      })
    );
    expect(readHeaders(fetchMock, 0).get("Content-Type")).toBe("application/json");
    expect(readHeaders(fetchMock, 0).get("X-Correlation-Id")).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/auth/mfa",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          userId,
          code: "123456"
        }),
        method: "POST"
      })
    );
    expect(readHeaders(fetchMock, 1).get("Content-Type")).toBe("application/json");
    expect(readHeaders(fetchMock, 1).get("X-Correlation-Id")).toEqual(expect.any(String));
    expect(screen.getByLabelText("ExpenseFlow navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Current role view")).toHaveTextContent("Finance Admin");

    await user.click(screen.getByRole("button", { name: "Logout" }));

    expect(await screen.findByRole("heading", { name: "ExpenseFlow" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(authSessionStorageKey)).toBeNull();
  });

  it("composes the sidebar, metrics, stage stepper, and Expense Report table when restored", () => {
    window.history.replaceState(null, "", "/app/expense-reports");
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

  it("refreshes through the default auth client when an app API request returns 401", async () => {
    window.history.replaceState(null, "", "/app/approval-queue");
    const originalAccessToken = createSyntheticJwt(300_000);
    const refreshedAccessToken = createSyntheticJwt(300_000, "refreshed");
    window.sessionStorage.setItem(
      authSessionStorageKey,
      JSON.stringify({
        accessToken: originalAccessToken,
        refreshToken: "synthetic-refresh-token",
        tenantId,
        userId,
        roles: ["Finance Admin"]
      })
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createFetchResponse(
          {
            type: "/problems/unauthorized",
            title: "Unauthorized",
            status: 401,
            detail: "Expired access token."
          },
          401
        )
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          status: "authenticated",
          tenantId,
          userId,
          roles: ["Finance Admin"],
          accessToken: refreshedAccessToken,
          refreshToken: "synthetic-refreshed-token"
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          cases: [
            {
              id: "00000000-0000-4000-8000-000000000701",
              currentStage: "Submitted",
              priority: "High",
              dueDate: "2026-07-28",
              onHold: false,
              updatedAt: "2026-07-24T12:00:00.000Z"
            }
          ]
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Case / Approval Queue" })
    ).toBeInTheDocument();
    expect(screen.getByText("Submitted")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/auth/refresh",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          userId,
          refreshToken: "synthetic-refresh-token"
        }),
        method: "POST"
      })
    );
    expect(readHeaders(fetchMock, 0).get("Authorization")).toBe(`Bearer ${originalAccessToken}`);
    expect(readHeaders(fetchMock, 2).get("Authorization")).toBe(`Bearer ${refreshedAccessToken}`);
  });
});

function createFetchResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function readHeaders(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  callIndex: number
): Headers {
  const [, init] = fetchMock.mock.calls[callIndex] ?? [];

  if (init === undefined || !("headers" in init) || init.headers === undefined) {
    throw new Error("Expected request headers.");
  }

  return new Headers(init.headers);
}

function createSyntheticJwt(expiresInMs: number, label = "initial"): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncode({
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    label,
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
