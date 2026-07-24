import type { UserRole } from "../domain";

export interface LoginCredentials {
  tenantId: string;
  email: string;
  password: string;
}

export interface MfaChallenge {
  tenantId: string;
  userId: string;
  message: string;
}

export interface CompleteMfaInput {
  tenantId: string;
  userId: string;
  code: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  roles: readonly string[];
  role: UserRole;
  isAuthenticated: true;
}

export type LoginResult =
  | {
      status: "mfa_required";
      challenge: MfaChallenge;
    }
  | {
      status: "authenticated";
      session: AuthSession;
    };

export interface AuthClient {
  login(credentials: LoginCredentials, signal: AbortSignal): Promise<LoginResult>;
  completeMfa(input: CompleteMfaInput, signal: AbortSignal): Promise<AuthSession>;
}

export function createHttpAuthClient(baseUrl = "/v1"): AuthClient {
  return {
    async login(credentials, signal) {
      const body = await postJson(`${baseUrl}/auth/login`, credentials, signal);

      if (isMfaRequiredResponse(body)) {
        return {
          status: "mfa_required",
          challenge: {
            tenantId: body.tenantId,
            userId: body.userId,
            message: body.message
          }
        };
      }

      if (isAuthenticatedResponse(body)) {
        return {
          status: "authenticated",
          session: toAuthSession(body)
        };
      }

      throw new Error("Unexpected login response.");
    },
    async completeMfa(input, signal) {
      const body = await postJson(`${baseUrl}/auth/mfa`, input, signal);

      if (!isAuthenticatedResponse(body)) {
        throw new Error("Unexpected MFA response.");
      }

      return toAuthSession(body);
    }
  };
}

function toAuthSession(response: AuthenticatedResponse): AuthSession {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    tenantId: response.tenantId,
    userId: response.userId,
    roles: response.roles,
    role: selectPrimaryRole(response.roles),
    isAuthenticated: true
  };
}

export function selectPrimaryRole(roles: readonly string[]): UserRole {
  if (roles.includes("ExpenseFlow Platform Admin") || roles.includes("Platform Admin")) {
    return "Platform Admin";
  }

  const supportedRoles: readonly UserRole[] = ["Finance Admin", "Department Manager", "Employee"];

  return supportedRoles.find((role) => roles.includes(role)) ?? "Employee";
}

async function postJson(url: string, payload: object, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST",
    signal
  });
  const body = await response.json().catch((): unknown => ({}));

  if (!response.ok) {
    throw new Error(readProblemDetail(body) ?? "Authentication request failed.");
  }

  return body;
}

function readProblemDetail(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  return typeof body.detail === "string" ? body.detail : undefined;
}

interface MfaRequiredResponse {
  status: "mfa_required";
  tenantId: string;
  userId: string;
  message: string;
}

interface AuthenticatedResponse {
  status: "authenticated";
  tenantId: string;
  userId: string;
  roles: readonly string[];
  accessToken: string;
  refreshToken: string;
}

function isMfaRequiredResponse(value: unknown): value is MfaRequiredResponse {
  return (
    isRecord(value) &&
    value.status === "mfa_required" &&
    typeof value.tenantId === "string" &&
    typeof value.userId === "string" &&
    typeof value.message === "string"
  );
}

function isAuthenticatedResponse(value: unknown): value is AuthenticatedResponse {
  return (
    isRecord(value) &&
    value.status === "authenticated" &&
    typeof value.tenantId === "string" &&
    typeof value.userId === "string" &&
    Array.isArray(value.roles) &&
    value.roles.every((role) => typeof role === "string") &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
