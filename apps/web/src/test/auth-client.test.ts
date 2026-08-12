import { createHttpAuthClient, selectPrimaryRole } from "../auth";

const tenantId = "00000000-0000-4000-8000-000000000501";
const userId = "00000000-0000-4000-8000-000000000601";

describe("auth client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the configured deployed API base URL for auth requests", async () => {
    vi.stubEnv("VITE_EXPENSEFLOW_API_BASE_URL", "http://expenseflow-api.test/v1");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createFetchResponse({
        status: "authenticated",
        tenantId,
        userId,
        roles: ["Employee"],
        accessToken: createSyntheticJwt(300_000),
        refreshToken: "synthetic-refresh-token"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const authClient = createHttpAuthClient();
    await authClient.login(
      {
        tenantId,
        email: "synthetic.employee@example.test",
        password: "synthetic-password"
      },
      new AbortController().signal
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://expenseflow-api.test/v1/auth/login",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("posts credentials and MFA inputs to the configured auth API", async () => {
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
          roles: ["Employee"],
          accessToken: createSyntheticJwt(300_000),
          refreshToken: "synthetic-refresh-token"
        })
      )
      .mockResolvedValueOnce(
        createFetchResponse({
          status: "authenticated",
          tenantId,
          userId,
          roles: ["Employee"],
          accessToken: createSyntheticJwt(300_000),
          refreshToken: "synthetic-refreshed-token"
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const authClient = createHttpAuthClient("http://localhost:3000/v1");
    await authClient.login(
      {
        tenantId,
        email: "synthetic.employee@example.test",
        password: "synthetic-password"
      },
      new AbortController().signal
    );
    await authClient.completeMfa(
      {
        tenantId,
        userId,
        code: "123456"
      },
      new AbortController().signal
    );
    await authClient.refreshSession(
      {
        accessToken: createSyntheticJwt(300_000),
        refreshToken: "synthetic-refresh-token",
        tenantId,
        userId,
        roles: ["Employee"],
        role: "Employee",
        isAuthenticated: true
      },
      new AbortController().signal
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3000/v1/auth/login",
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
      "http://localhost:3000/v1/auth/mfa",
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
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3000/v1/auth/refresh",
      expect.objectContaining({
        body: JSON.stringify({
          tenantId,
          userId,
          refreshToken: "synthetic-refresh-token"
        }),
        method: "POST"
      })
    );
    expect(readHeaders(fetchMock, 2).get("Content-Type")).toBe("application/json");
    expect(readHeaders(fetchMock, 2).get("X-Correlation-Id")).toEqual(expect.any(String));
  });

  it("maps platform roles without downgrading them to Employee", () => {
    expect(selectPrimaryRole(["ExpenseFlow Platform Admin"])).toBe("Platform Admin");
    expect(selectPrimaryRole(["Platform Admin"])).toBe("Platform Admin");
  });
});

function createFetchResponse(body: object): Response {
  return {
    ok: true,
    status: 200,
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

function createSyntheticJwt(expiresInMs: number): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncode({
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    roles: ["Employee"],
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
