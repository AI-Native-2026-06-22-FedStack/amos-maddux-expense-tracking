import { createHttpAuthClient, selectPrimaryRole } from "../auth";

const tenantId = "00000000-0000-4000-8000-000000000501";
const userId = "00000000-0000-4000-8000-000000000601";

describe("auth client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3000/v1/auth/login",
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
      "http://localhost:3000/v1/auth/mfa",
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
  });

  it("maps platform roles without downgrading them to Employee", () => {
    expect(selectPrimaryRole(["ExpenseFlow Platform Admin"])).toBe("Platform Admin");
    expect(selectPrimaryRole(["Platform Admin"])).toBe("Platform Admin");
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
