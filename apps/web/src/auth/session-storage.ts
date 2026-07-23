import type { AuthSession } from "./auth-client";
import { readAccessTokenExpiry } from "./token-expiry";
import { selectPrimaryRole } from "./auth-client";

export const authSessionStorageKey = "expenseflow.auth.session.v1";

export interface AuthSessionStorage {
  load(): AuthSession | null;
  save(session: AuthSession): void;
  clear(): void;
}

export function createSessionStorage(): AuthSessionStorage {
  return {
    load() {
      const rawValue = window.sessionStorage.getItem(authSessionStorageKey);

      if (rawValue === null) {
        return null;
      }

      try {
        const parsedValue: unknown = JSON.parse(rawValue);
        const session = parseStoredSession(parsedValue);

        if (session === null || isExpired(session.accessToken)) {
          window.sessionStorage.removeItem(authSessionStorageKey);
          return null;
        }

        return session;
      } catch {
        window.sessionStorage.removeItem(authSessionStorageKey);
        return null;
      }
    },
    save(session) {
      window.sessionStorage.setItem(authSessionStorageKey, JSON.stringify(session));
    },
    clear() {
      window.sessionStorage.removeItem(authSessionStorageKey);
    }
  };
}

function parseStoredSession(value: unknown): AuthSession | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.tenantId !== "string" ||
    typeof value.userId !== "string" ||
    !Array.isArray(value.roles) ||
    !value.roles.every((role) => typeof role === "string")
  ) {
    return null;
  }

  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    tenantId: value.tenantId,
    userId: value.userId,
    roles: value.roles,
    role: selectPrimaryRole(value.roles),
    isAuthenticated: true
  };
}

function isExpired(accessToken: string): boolean {
  const expiresAt = readAccessTokenExpiry(accessToken);

  return expiresAt === null || expiresAt <= Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
