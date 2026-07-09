import { describe, expect, it } from "vitest";

import jwt from "jsonwebtoken";

import { issueTokenPair, loadJwtRuntimeConfig } from "../src/auth/tokens.js";

const tenantId = "00000000-0000-4000-8000-000000000601";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000602";

describe("JWT token issuance", () => {
  it("issues an RS256 access token with configured header and claims", () => {
    const config = loadJwtRuntimeConfig();
    const tokenPair = issueTokenPair({
      tenantId,
      userId,
      roles: ["Employee"]
    });
    const decoded = jwt.decode(tokenPair.accessToken, { complete: true });

    expect(decoded).not.toBeNull();

    if (!isDecodedJwt(decoded)) {
      throw new Error("Synthetic token decoding failed.");
    }

    expect(decoded.header).toMatchObject({
      alg: "RS256",
      kid: config.keyId
    });
    expect(decoded.payload).toMatchObject({
      iss: config.issuer,
      aud: config.audience,
      sub: userId,
      tenantId,
      roles: ["Employee"]
    });
    expect(typeof decoded.payload.exp).toBe("number");
  });

  it("verifies the issued access token with the RS256 public key", () => {
    const config = loadJwtRuntimeConfig();
    const tokenPair = issueTokenPair({
      tenantId,
      userId,
      roles: ["Employee"]
    });

    const verified = jwt.verify(tokenPair.accessToken, config.publicKeyPem, {
      algorithms: ["RS256"],
      issuer: config.issuer,
      audience: config.audience
    });

    expect(verified).toMatchObject({
      sub: userId,
      tenantId,
      roles: ["Employee"]
    });
  });
});

function isDecodedJwt(decoded: unknown): decoded is {
  header: { alg: string; kid?: string };
  payload: jwt.JwtPayload;
} {
  if (typeof decoded !== "object" || decoded === null) {
    return false;
  }

  const candidate = decoded as {
    header?: unknown;
    payload?: unknown;
  };

  return (
    typeof candidate.header === "object" &&
    candidate.header !== null &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}
