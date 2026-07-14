import { createHash, randomBytes } from "node:crypto";

import jwt from "jsonwebtoken";

import { getApiRuntimeConfig } from "../config/runtime-config.js";
import { getRuntimeSecrets } from "../config/runtime-secrets.js";

export interface AuthenticatedPrincipal {
  userId: string;
  tenantId: string;
  roles: string[];
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
}

export interface JwtRuntimeConfig {
  issuer: string;
  audience: string;
  keyId: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  privateKeyPem: string;
  publicKeyPem: string;
}

export function issueTokenPair(principal: AuthenticatedPrincipal): IssuedTokenPair {
  const config = loadJwtRuntimeConfig();
  const accessToken = jwt.sign(
    {
      tenantId: principal.tenantId,
      roles: principal.roles
    },
    config.privateKeyPem,
    {
      algorithm: "RS256",
      keyid: config.keyId,
      issuer: config.issuer,
      audience: config.audience,
      expiresIn: config.accessTokenTtlSeconds,
      subject: principal.userId
    }
  );
  const refreshToken = randomBytes(48).toString("base64url");
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const refreshTokenExpiresAt = new Date(Date.now() + config.refreshTokenTtlSeconds * 1000);

  return {
    accessToken,
    refreshToken,
    refreshTokenHash,
    refreshTokenExpiresAt
  };
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

export function loadJwtRuntimeConfig(): JwtRuntimeConfig {
  const config = getApiRuntimeConfig();
  const secrets = getRuntimeSecrets();

  return {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    keyId: config.JWT_KEY_ID,
    accessTokenTtlSeconds: config.JWT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: config.JWT_REFRESH_TOKEN_TTL_SECONDS,
    privateKeyPem: secrets.jwtSigningKeys.privateKeyPem,
    publicKeyPem: secrets.jwtSigningKeys.publicKeyPem
  };
}
