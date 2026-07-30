import { generateKeyPairSync } from "node:crypto";

import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";

import {
  getRuntimeSecrets,
  preloadRuntimeSecrets,
  refreshRuntimeSecrets,
  setRuntimeSecretsForTest,
  type SecretsManagerSender
} from "./runtime-secrets.js";
import { loadApiRuntimeConfig } from "./runtime-config.js";

const jwtKeyPair = generateJwtKeyPair();
const rotatedJwtKeyPair = generateJwtKeyPair();
const mismatchedJwtKeyPair = generateJwtKeyPair();
const invalidPrivateKeyPem = pem("PRIVATE KEY", "synthetic-private-key-material");

const config = loadApiRuntimeConfig({
  NODE_ENV: "production",
  AWS_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  SNS_STAGE_EVENTS_TOPIC: "expenseflow-stage-events",
  SQS_STAGE_EVENTS_QUEUE: "expenseflow-stage-projection",
  SQS_STAGE_EVENTS_DLQ: "expenseflow-stage-projection-dlq",
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
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify(jwtKeyPair)
    });

    await expect(preloadRuntimeSecrets(config, client)).resolves.toEqual({
      dbPassword: "synthetic-db-password",
      jwtSigningKeys: {
        privateKeyPem: jwtKeyPair.privateKeyPem.trim(),
        publicKeyPem: jwtKeyPair.publicKeyPem.trim()
      }
    });
    expect(getRuntimeSecrets().dbPassword).toBe("synthetic-db-password");
  });

  it("preserves the DB password secret exactly as stored", async () => {
    setRuntimeSecretsForTest(undefined);
    const password = " synthetic-db-password-with-edge-whitespace ";
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: password,
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify(jwtKeyPair)
    });

    await preloadRuntimeSecrets(config, client);

    expect(getRuntimeSecrets().dbPassword).toBe(password);
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
      "invalid private key PEM body",
      {
        jwtSigningKeys: JSON.stringify({
          privateKeyPem: invalidPrivateKeyPem,
          publicKeyPem: jwtKeyPair.publicKeyPem
        })
      }
    ],
    [
      "swapped private and public keys",
      {
        jwtSigningKeys: JSON.stringify({
          privateKeyPem: jwtKeyPair.publicKeyPem,
          publicKeyPem: jwtKeyPair.privateKeyPem
        })
      }
    ],
    [
      "mismatched private and public keys",
      {
        jwtSigningKeys: JSON.stringify({
          privateKeyPem: jwtKeyPair.privateKeyPem,
          publicKeyPem: mismatchedJwtKeyPair.publicKeyPem
        })
      }
    ]
  ])("fails preload for %s", async (_name, overrides) => {
    setRuntimeSecretsForTest(undefined);
    const secrets: Record<string, string | undefined> = {
      [config.DB_PASSWORD_SECRET_ID]: overrides.dbPassword ?? "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: Object.hasOwn(overrides, "jwtSigningKeys")
        ? overrides.jwtSigningKeys
        : JSON.stringify(jwtKeyPair)
    };
    const client = createFakeSecretsManagerClient(secrets);

    await expect(preloadRuntimeSecrets(config, client)).rejects.toThrow();
  });

  it("refreshes cached values after rotation", async () => {
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify(jwtKeyPair)
    });
    await preloadRuntimeSecrets(config, client);

    client.setSecret(config.DB_PASSWORD_SECRET_ID, "rotated-synthetic-db-password");
    client.setSecret(config.JWT_SIGNING_KEYS_SECRET_ID, JSON.stringify(rotatedJwtKeyPair));

    await expect(refreshRuntimeSecrets(config, client)).resolves.toBe(true);
    expect(getRuntimeSecrets()).toEqual({
      dbPassword: "rotated-synthetic-db-password",
      jwtSigningKeys: {
        privateKeyPem: rotatedJwtKeyPair.privateKeyPem.trim(),
        publicKeyPem: rotatedJwtKeyPair.publicKeyPem.trim()
      }
    });
  });

  it("logs refresh failure without leaking secret payloads and keeps the last valid cache", async () => {
    const { logger, logLines } = createCapturedLogger();
    const client = createFakeSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify(jwtKeyPair)
    });
    await preloadRuntimeSecrets(config, client);
    client.failRequests();

    await expect(refreshRuntimeSecrets(config, client, { logger })).resolves.toBe(false);
    expect(getRuntimeSecrets().dbPassword).toBe("synthetic-db-password");

    const output = logLines.join("");
    expect(output).toContain("Runtime secret refresh failed");
    expect(output).toContain(config.DB_PASSWORD_SECRET_ID);
    expect(output).not.toContain("synthetic-db-password");
    expect(output).not.toContain(jwtKeyPair.privateKeyPem);
    expect(output).not.toContain(jwtKeyPair.publicKeyPem);
  });

  it("does not overlap concurrent refreshes", async () => {
    const client = createDeferredSecretsManagerClient({
      [config.DB_PASSWORD_SECRET_ID]: "synthetic-db-password",
      [config.JWT_SIGNING_KEYS_SECRET_ID]: JSON.stringify(jwtKeyPair)
    });
    await preloadRuntimeSecrets(config, client);
    client.setSecret(config.DB_PASSWORD_SECRET_ID, "rotated-synthetic-db-password");
    client.deferRequests();

    const firstRefresh = refreshRuntimeSecrets(config, client);
    const secondRefresh = refreshRuntimeSecrets(config, client);

    expect(client.activeRequestCount()).toBe(2);

    client.resolveDeferredRequests();

    await expect(firstRefresh).resolves.toBe(true);
    await expect(secondRefresh).resolves.toBe(true);
    expect(client.maxActiveRequestCount()).toBe(2);
    expect(getRuntimeSecrets().dbPassword).toBe("rotated-synthetic-db-password");
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

function generateJwtKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
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
    privateKeyPem: keyPair.privateKey,
    publicKeyPem: keyPair.publicKey
  };
}

function createCapturedLogger(): { logger: Logger; logLines: string[] } {
  const logLines: string[] = [];
  const logger = pino(
    {
      level: "debug"
    },
    {
      write(line) {
        logLines.push(line);
      }
    }
  );

  return { logger, logLines };
}

function createDeferredSecretsManagerClient(initialSecrets: Record<string, string | undefined>) {
  const baseClient = createFakeSecretsManagerClient(initialSecrets);
  let shouldDefer = false;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const deferredRequestResolvers: Array<() => void> = [];

  return {
    async send(command) {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);

      try {
        if (shouldDefer) {
          await new Promise<void>((resolve) => {
            deferredRequestResolvers.push(resolve);
          });
        }

        return await baseClient.send(command);
      } finally {
        activeRequests -= 1;
      }
    },
    setSecret: baseClient.setSecret,
    failRequests: baseClient.failRequests,
    deferRequests() {
      shouldDefer = true;
    },
    resolveDeferredRequests() {
      shouldDefer = false;
      for (const resolve of deferredRequestResolvers.splice(0)) {
        resolve();
      }
    },
    activeRequestCount() {
      return activeRequests;
    },
    maxActiveRequestCount() {
      return maxActiveRequests;
    }
  } satisfies SecretsManagerSender & {
    setSecret(secretId: string, secretString: string): void;
    failRequests(): void;
    deferRequests(): void;
    resolveDeferredRequests(): void;
    activeRequestCount(): number;
    maxActiveRequestCount(): number;
  };
}
