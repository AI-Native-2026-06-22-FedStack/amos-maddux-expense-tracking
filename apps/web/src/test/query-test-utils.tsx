import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  AuthSessionProvider,
  type AuthSession,
  type AuthSessionStorage,
  authSessionStorageKey
} from "../auth";

export const tenantId = "00000000-0000-4000-8000-000000000501";
export const userId = "00000000-0000-4000-8000-000000000601";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        retry: false
      },
      queries: {
        retry: false
      }
    }
  });
}

export function createQueryAuthWrapper(queryClient = createTestQueryClient()) {
  const storage = createMemoryStorage(createSession());

  return {
    queryClient,
    wrapper({ children }: { children: ReactNode }) {
      return (
        <AuthSessionProvider storage={storage}>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </AuthSessionProvider>
      );
    }
  };
}

export function createSession(): AuthSession {
  return {
    accessToken: createSyntheticJwt(300_000),
    refreshToken: "synthetic-refresh-token",
    tenantId,
    userId,
    roles: ["Finance Admin"],
    role: "Finance Admin",
    isAuthenticated: true
  };
}

export function createFetchResponse(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status
  } as Response;
}

function createMemoryStorage(initialSession: AuthSession | null): AuthSessionStorage {
  let storedSession = initialSession;

  return {
    load: () => storedSession,
    save: (session) => {
      storedSession = session;
      window.sessionStorage.setItem(authSessionStorageKey, JSON.stringify(session));
    },
    clear: () => {
      storedSession = null;
      window.sessionStorage.removeItem(authSessionStorageKey);
    }
  };
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
