import { ApiProblemError, createApiClient } from "../api";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches bearer and correlation headers on every request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse({ ok: true }));
    const client = createApiClient({
      createCorrelationId: () => "synthetic-correlation-id",
      fetchImpl: fetchMock,
      getAccessToken: () => "synthetic-access-token"
    });

    await client.requestJson<{ ok: boolean }>("/expense-reports");

    const headers = readHeaders(fetchMock, 0);
    expect(headers.get("Authorization")).toBe("Bearer synthetic-access-token");
    expect(headers.get("X-Correlation-Id")).toBe("synthetic-correlation-id");
  });

  it("maps Problem JSON into a typed UI error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse(
        {
          type: "/problems/synthetic-problem",
          title: "Synthetic Failure",
          status: 422,
          detail: "Synthetic detail.",
          instance: "/v1/synthetic"
        },
        422
      )
    );
    const client = createApiClient({
      createCorrelationId: () => "synthetic-correlation-id",
      fetchImpl: fetchMock
    });

    await expect(client.requestJson<unknown>("/synthetic")).rejects.toMatchObject({
      correlationId: "synthetic-correlation-id",
      detail: "Synthetic detail.",
      instance: "/v1/synthetic",
      kind: "problem",
      status: 422,
      title: "Synthetic Failure",
      type: "/problems/synthetic-problem"
    });
    await expect(client.requestJson<unknown>("/synthetic")).rejects.toBeInstanceOf(ApiProblemError);
  });

  it("maps malformed non-ok responses into a typed fallback error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse(null, 500));
    const client = createApiClient({
      createCorrelationId: () => "synthetic-correlation-id",
      fetchImpl: fetchMock
    });

    await expect(client.requestJson<unknown>("/synthetic")).rejects.toMatchObject({
      detail: "HTTP 500.",
      kind: "problem",
      status: 500,
      title: "HTTP 500",
      type: "about:blank"
    });
  });

  it("refreshes once after a 401 and retries the original request with the new token", async () => {
    let accessToken = "synthetic-expired-token";
    const refreshSession = vi.fn(async () => {
      accessToken = "synthetic-refreshed-token";
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({ detail: "Expired." }, 401))
      .mockResolvedValueOnce(createJsonResponse({ status: "ok" }));
    const client = createApiClient({
      createCorrelationId: () => "synthetic-correlation-id",
      fetchImpl: fetchMock,
      getAccessToken: () => accessToken,
      refreshSession
    });

    await expect(client.requestJson<{ status: string }>("/expense-reports")).resolves.toEqual({
      status: "ok"
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readHeaders(fetchMock, 0).get("Authorization")).toBe("Bearer synthetic-expired-token");
    expect(readHeaders(fetchMock, 1).get("Authorization")).toBe("Bearer synthetic-refreshed-token");
  });

  it("does not loop when the retried request is still 401", async () => {
    const refreshSession = vi.fn(async () => undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({ detail: "Expired." }, 401))
      .mockResolvedValueOnce(createJsonResponse({ detail: "Still expired." }, 401));
    const client = createApiClient({
      fetchImpl: fetchMock,
      refreshSession
    });

    await expect(client.requestJson<unknown>("/expense-reports")).rejects.toMatchObject({
      detail: "Still expired.",
      status: 401
    });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight refresh across concurrent 401 responses", async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({ detail: "Expired." }, 401))
      .mockResolvedValueOnce(createJsonResponse({ detail: "Expired." }, 401))
      .mockResolvedValueOnce(createJsonResponse({ id: "first" }))
      .mockResolvedValueOnce(createJsonResponse({ id: "second" }));
    const client = createApiClient({
      fetchImpl: fetchMock,
      refreshSession
    });

    const firstRequest = client.requestJson<{ id: string }>("/expense-reports/first");
    const secondRequest = client.requestJson<{ id: string }>("/expense-reports/second");
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));

    resolveRefresh?.();

    await expect(firstRequest).resolves.toEqual({ id: "first" });
    await expect(secondRequest).resolves.toEqual({ id: "second" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("routes to login when refresh fails", async () => {
    const onRefreshFailed = vi.fn();
    const refreshSession = vi.fn(async () => {
      throw new Error("Synthetic refresh failure.");
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createJsonResponse({ detail: "Expired." }, 401));
    const client = createApiClient({
      fetchImpl: fetchMock,
      onRefreshFailed,
      refreshSession
    });

    await expect(client.requestJson<unknown>("/expense-reports")).rejects.toMatchObject({
      detail: "Expired.",
      status: 401
    });
    expect(onRefreshFailed).toHaveBeenCalledTimes(1);
  });
});

function createJsonResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status
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
