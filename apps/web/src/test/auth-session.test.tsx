import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import {
  AuthSessionProvider,
  type AuthClient,
  type AuthSession,
  type AuthSessionStorage,
  type RefreshSession,
  useAuthSession
} from "../auth";

const tenantId = "00000000-0000-4000-8000-000000000501";
const userId = "00000000-0000-4000-8000-000000000601";

describe("useAuthSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts unauthenticated when storage is empty", () => {
    const storage = createMemoryStorage(null);
    const { result } = renderAuthHook({ storage });

    expect(result.current.phase).toBe("unauthenticated");
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.getCurrentAccessToken()).toBeNull();
  });

  it("moves from login to MFA challenge", async () => {
    const authClient = createAuthClient();
    const { result } = renderAuthHook({ authClient });

    await act(async () => {
      await result.current.login({
        tenantId,
        email: "synthetic.employee@example.test",
        password: "synthetic-password"
      });
    });

    expect(result.current.phase).toBe("mfa_required");
    expect(result.current.mfaChallenge).toEqual({
      tenantId,
      userId,
      message: "MFA required."
    });
  });

  it("completes MFA, exposes the current access token, and persists the session", async () => {
    const session = createSession();
    const authClient = createAuthClient({ session });
    const storage = createMemoryStorage(null);
    const { result } = renderAuthHook({ authClient, storage });

    await act(async () => {
      await result.current.login({
        tenantId,
        email: "synthetic.employee@example.test",
        password: "synthetic-password"
      });
    });

    await waitFor(() => expect(result.current.phase).toBe("mfa_required"));

    await act(async () => {
      await result.current.completeMfa("123456");
    });

    expect(result.current.phase).toBe("authenticated");
    expect(result.current.session).toEqual(session);
    expect(result.current.getCurrentAccessToken()).toBe(session.accessToken);
    expect(storage.snapshot()).toEqual(session);
  });

  it("restores a valid stored session", () => {
    const session = createSession();
    const storage = createMemoryStorage(session);
    const { result } = renderAuthHook({ storage });

    expect(result.current.phase).toBe("authenticated");
    expect(result.current.session).toEqual(session);
  });

  it("clears state and storage on logout", () => {
    const storage = createMemoryStorage(createSession());
    const { result } = renderAuthHook({ storage });

    act(() => {
      result.current.logout();
    });

    expect(result.current.phase).toBe("unauthenticated");
    expect(result.current.session).toBeNull();
    expect(storage.snapshot()).toBeNull();
  });

  it("discards expired stored sessions", () => {
    const storage = createMemoryStorage(createSession({ expiresInMs: -1_000 }));
    const { result } = renderAuthHook({ storage });

    expect(result.current.phase).toBe("unauthenticated");
    expect(storage.snapshot()).toBeNull();
  });

  it("aborts an in-flight refresh and clears its timer on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));

    const refreshSignals: AbortSignal[] = [];
    const storage = createMemoryStorage(createSession({ expiresInMs: 61_000 }));
    const refreshSession: RefreshSession = (_session, signal) => {
      refreshSignals.push(signal);
      return new Promise<AuthSession>(() => undefined);
    };
    const { result, unmount } = renderAuthHook({ refreshSession, storage });

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current.phase).toBe("refreshing");

    unmount();

    expect(refreshSignals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

interface RenderAuthHookOptions {
  authClient?: AuthClient;
  refreshSession?: RefreshSession;
  storage?: AuthSessionStorage;
}

function renderAuthHook({ authClient, refreshSession, storage }: RenderAuthHookOptions = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthSessionProvider authClient={authClient} refreshSession={refreshSession} storage={storage}>
      {children}
    </AuthSessionProvider>
  );

  return renderHook(() => useAuthSession(), { wrapper });
}

interface CreateAuthClientOptions {
  session?: AuthSession;
}

function createAuthClient(options: CreateAuthClientOptions = {}): AuthClient {
  const session = options.session ?? createSession();

  return {
    login: async () => ({
      status: "mfa_required",
      challenge: {
        tenantId,
        userId,
        message: "MFA required."
      }
    }),
    completeMfa: async () => session
  };
}

function createMemoryStorage(initialSession: AuthSession | null): AuthSessionStorage & {
  snapshot(): AuthSession | null;
} {
  let storedSession = initialSession;

  return {
    load: () => storedSession,
    save: (session) => {
      storedSession = session;
    },
    clear: () => {
      storedSession = null;
    },
    snapshot: () => storedSession
  };
}

interface CreateSessionOptions {
  expiresInMs?: number;
  roles?: readonly string[];
}

function createSession(options: CreateSessionOptions = {}): AuthSession {
  const roles = options.roles ?? ["Employee"];

  return {
    accessToken: createSyntheticJwt(options.expiresInMs ?? 300_000),
    refreshToken: "synthetic-refresh-token",
    tenantId,
    userId,
    roles,
    role: roles.includes("Finance Admin") ? "Finance Admin" : "Employee",
    isAuthenticated: true
  };
}

function createSyntheticJwt(expiresInMs: number): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncode({ exp: Math.floor((Date.now() + expiresInMs) / 1000) });

  return `${header}.${payload}.synthetic-signature`;
}

function base64UrlEncode(value: object): string {
  return window
    .btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
