import { describe, expect, it } from "vitest";

import {
  getRuntimeSecrets,
  preloadRuntimeSecrets,
  refreshRuntimeSecrets,
  setRuntimeSecretsForTest,
  type SecretsManagerSender
} from "./runtime-secrets.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";

const privateKeyPem = pem("PRIVATE KEY", "synthetic-private-key-material");
const publicKeyPem = pem("PUBLIC KEY", "synthetic-public-key-material");
const rotatedPrivateKeyPem = pem("PRIVATE KEY", "rotated-synthetic-private-key-material");
const rotatedPublicKeyPem = pem("PUBLIC KEY", "rotated-synthetic-public-key-material");

const config = loadApiRuntimeConfig({
  NODE_ENV: "production",
  AWS_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  DB_PASSWORD_SECRET_ID: "expenseflow/local/db-password",
  JWT_SIGNING_KEYS_SECRET_ID: "expenseflow/local/jwt-signing-keys",
  DATABASE_URI: "postgres://expenseflow@localhost:5432/expenseflow",
  REDIS_URL: "redis://localhost:6379",
  EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: "60000",
  EXPENSE_WRITE_RATE_LIMIT_MAX: "120",
  EXPENSE_WRITE_SLOW_DOWN_AFTER: "80",
  EXPENSE_WRITE_DELAY_INCREMENT_MS: "250",
  EXPENSE_WRITE_MAX_DELAY_MS: "5000"
});

describe("runtime secrets cache", () => {
  it("preloads the DB password and JWT signing keys", async () => {
    setRuntimeSecretsForTest(undefined);
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify({ privateKeyPem, publicKeyPem })
    });

    await expect(preloadRuntimeSecrets(config, client)).resolves.toEqual({
      dbPassword: "synthetic-db-password",
      jwtSigningKeys: {
        privateKeyPem,
        publicKeyPem
      }
    });
    expect(getRuntimeSecrets().dbPassword).toBe("synthetic-db-password");
  });

  it.each<
    [
      string,
      {
        dbPassword?: string;
        jwtSigningKeys?: string;
      }
    ]
  >([
    ["empty DB password", { dbPassword: "" }],
    ["missing JWT secret", { jwtSigningKeys: undefined }],
    ["invalid JWT JSON", { jwtSigningKeys: "not-json" }],
    [
      "malformed PEM",
      { jwtSigningKeys: JSON.stringify({ privateKeyPem: publicKeyPem, publicKeyPem }) }
    ]
  ])("fails preload for %s", async (_name, overrides) => {
    setRuntimeSecretsForTest(undefined);
    const secrets: Record<string, string | undefined> = {
      [config.DB_PASSWORD_SECRET_ID]: overrides.dbPassword ?? "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: Object.hasOwn(overrides, "jwtSigningKeys")
        ? overrides.jwtSigningKeys
        : JSON.stringify({ privateKeyPem, publicKeyPem })
    };
    const client = createFakeSecretsManagerClient(secrets);

    await expect(preloadRuntimeSecrets(config, client)).rejects.toThrow();
  });

  it("refreshes cached values after rotation", async () => {
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify({ privateKeyPem, publicKeyPem })
    });
    await preloadRuntimeSecrets(config, client);

    client.setSecret(config.DB_PASSWORD_SECRET_ID, "rotated-synthetic-db-password");
    client.setSecret(
      config.JWT_SIGNING_KEYS_SECRET_ID,
      JSON.stringify({
        privateKeyPem: rotatedPrivateKeyPem,
        publicKeyPem: rotatedPublicKeyPem
      })
    );

    await expect(refreshRuntimeSecrets(config, client)).resolves.toBe(true);
    expect(getRuntimeSecrets()).toEqual({
      dbPassword: "rotated-synthetic-db-password",
      jwtSigningKeys: {
        privateKeyPem: rotatedPrivateKeyPem,
        publicKeyPem: rotatedPublicKeyPem
      }
    });
  });

  it("keeps the last valid cache when refresh fails", async () => {
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify({ privateKeyPem, publicKeyPem })
    });
    await preloadRuntimeSecrets(config, client);
    client.failRequests();

    await expect(refreshRuntimeSecrets(config, client)).resolves.toBe(false);
    expect(getRuntimeSecrets().dbPassword).toBe("synthetic-db-password");
  });
});

function createFakeSecretsManagerClient(initialSecrets: Record<string, string | undefined>) {
  const secrets = new Map(Object.entries(initialSecrets));
  let shouldFail = false;

  return {
    async send(command) {
      if (shouldFail) {
        throw new Error("Synthetic LocalStack failure.");
      }

      const secretId = command.input.SecretId;

      if (typeof secretId !== "string") {
        return {};
      }

      const secretString = secrets.get(secretId);

      return secretString === undefined ? {} : { SecretString: secretString };
    },
    setSecret(secretId: string, secretString: string) {
      secrets.set(secretId, secretString);
    },
    failRequests() {
      shouldFail = true;
    }
  } satisfies SecretsManagerSender & {
    setSecret(secretId: string, secretString: string): void;
    failRequests(): void;
  };
}

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", body: string): string {
  return [`-----BEGIN ${label}-----`, body, `-----END ${label}-----`].join("\n");
}
