import { act, renderHook } from "@testing-library/react";
import {
  AuthSessionProvider,
  authSessionStorageKey,
  type AuthSession,
  type AuthSessionStorage,
  type RefreshSession
} from "../auth";
import { useApiClient } from "../api/useApiClient";
import { createFetchResponse, tenantId, userId } from "./query-test-utils";

describe("useApiClient", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("retries a 401 with the refreshed token from AuthSessionProvider", async () => {
    const expiredSession = createSession("expired");
    const refreshedSession = createSession("refreshed");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createFetchResponse({ detail: "Expired." }, 401))
      .mockResolvedValueOnce(createFetchResponse({ status: "ok" }));
    const refreshSession = vi.fn<RefreshSession>(async () => refreshedSession);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useApiClient(), {
      wrapper({ children }) {
        return (
          <AuthSessionProvider
            refreshSession={refreshSession}
            storage={createMemoryStorage(expiredSession)}
          >
            {children}
          </AuthSessionProvider>
        );
      }
    });

    await act(async () => {
      await expect(
        result.current.requestJson<{ status: string }>("/expense-reports")
      ).resolves.toEqual({
        status: "ok"
      });
    });

    expect(readHeaders(fetchMock, 0).get("Authorization")).toBe(
      `Bearer ${expiredSession.accessToken}`
    );
    expect(readHeaders(fetchMock, 1).get("Authorization")).toBe(
      `Bearer ${refreshedSession.accessToken}`
    );
  });
});

function createSession(label: string): AuthSession {
  return {
    accessToken: createSyntheticJwt(label),
    refreshToken: `synthetic-refresh-token-${label}`,
    tenantId,
    userId,
    roles: ["Finance Admin"],
    role: "Finance Admin",
    isAuthenticated: true
  };
}

function createMemoryStorage(initialSession: AuthSession): AuthSessionStorage {
  let storedSession: AuthSession | null = initialSession;

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

function createSyntheticJwt(label: string): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncode({
    exp: Math.floor((Date.now() + 300_000) / 1000),
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
