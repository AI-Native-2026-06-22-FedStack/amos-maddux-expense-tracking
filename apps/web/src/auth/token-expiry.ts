export function readAccessTokenExpiry(accessToken: string): number | null {
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

    if (!isRecord(decodedPayload) || typeof decodedPayload.exp !== "number") {
      return null;
    }

    return decodedPayload.exp * 1000;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
