export interface AccessTokenClaims {
  exp: number;
  roles: readonly string[];
  subject: string;
  tenantId: string;
}

export function readAccessTokenExpiry(accessToken: string): number | null {
  const claims = readAccessTokenClaims(accessToken);

  return claims === null ? null : claims.exp * 1000;
}

export function readAccessTokenClaims(accessToken: string): AccessTokenClaims | null {
  const [, payload] = accessToken.split(".");

  if (payload === undefined) {
    return null;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      "="
    );
    const decodedPayload: unknown = JSON.parse(window.atob(paddedPayload));

    if (
      !isRecord(decodedPayload) ||
      typeof decodedPayload.exp !== "number" ||
      typeof decodedPayload.tenantId !== "string" ||
      !Array.isArray(decodedPayload.roles) ||
      !decodedPayload.roles.every((role) => typeof role === "string")
    ) {
      return null;
    }

    const subject = typeof decodedPayload.sub === "string" ? decodedPayload.sub : "";

    return {
      exp: decodedPayload.exp,
      roles: decodedPayload.roles,
      subject,
      tenantId: decodedPayload.tenantId
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
