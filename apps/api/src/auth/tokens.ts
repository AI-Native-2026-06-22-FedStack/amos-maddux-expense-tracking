import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import jwt from "jsonwebtoken";

const accessTokenTtlSecondsDefault = 15 * 60;
const refreshTokenTtlSecondsDefault = 30 * 24 * 60 * 60;
const rsaModulusLengthBits = 2048;

let generatedLocalKeyPair: JwtKeyPair | undefined;

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

interface JwtKeyPair {
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
  const issuer = readStringEnv("JWT_ISSUER", "expense-api");
  const audience = readStringEnv("JWT_AUDIENCE", "expense-clients");
  const keyId = readStringEnv("JWT_KEY_ID", "local-development-key");
  const accessTokenTtlSeconds = readPositiveIntegerEnv(
    "JWT_ACCESS_TOKEN_TTL_SECONDS",
    accessTokenTtlSecondsDefault
  );
  const refreshTokenTtlSeconds = readPositiveIntegerEnv(
    "JWT_REFRESH_TOKEN_TTL_SECONDS",
    refreshTokenTtlSecondsDefault
  );
  const keyPair = loadConfiguredKeyPair();

  return {
    issuer,
    audience,
    keyId,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    privateKeyPem: keyPair.privateKeyPem,
    publicKeyPem: keyPair.publicKeyPem
  };
}

function loadConfiguredKeyPair(): JwtKeyPair {
  const privateKeyPem = readOptionalStringEnv("JWT_PRIVATE_KEY_PEM");
  const publicKeyPem = readOptionalStringEnv("JWT_PUBLIC_KEY_PEM");

  if (privateKeyPem !== undefined && publicKeyPem !== undefined) {
    return {
      privateKeyPem: normalizePemFromEnvironment(privateKeyPem),
      publicKeyPem: normalizePemFromEnvironment(publicKeyPem)
    };
  }

  if (privateKeyPem !== undefined || publicKeyPem !== undefined) {
    throw new Error("JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM must be configured together.");
  }

  const privateKeyPath = readOptionalStringEnv("JWT_PRIVATE_KEY_PATH");
  const publicKeyPath = readOptionalStringEnv("JWT_PUBLIC_KEY_PATH");

  if (privateKeyPath !== undefined && publicKeyPath !== undefined) {
    return {
      privateKeyPem: readFileSync(privateKeyPath, "utf8"),
      publicKeyPem: readFileSync(publicKeyPath, "utf8")
    };
  }

  if (privateKeyPath !== undefined || publicKeyPath !== undefined) {
    throw new Error("JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must be configured together.");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("RS256 JWT key material must be configured in production.");
  }

  generatedLocalKeyPair ??= generateLocalKeyPair();

  return generatedLocalKeyPair;
}

function normalizePemFromEnvironment(value: string): string {
  return value.replaceAll("\\n", "\n");
}

function generateLocalKeyPair(): JwtKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: rsaModulusLengthBits,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    }
  });

  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey
  };
}

function readStringEnv(name: string, defaultValue: string): string {
  const value = readOptionalStringEnv(name);

  return value ?? defaultValue;
}

function readOptionalStringEnv(name: string): string | undefined {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = readOptionalStringEnv(name);

  if (value === undefined) {
    return defaultValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}
