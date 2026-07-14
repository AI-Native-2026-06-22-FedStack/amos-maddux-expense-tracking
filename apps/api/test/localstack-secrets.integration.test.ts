import {
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceExistsException,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadApiRuntimeConfig } from "../src/config/runtime-config.js";
import { preloadRuntimeSecrets, setRuntimeSecretsForTest } from "../src/config/runtime-secrets.js";

const describeLocalStack = process.env.RUN_LOCALSTACK_TESTS === "1" ? describe : describe.skip;

describeLocalStack("LocalStack Secrets Manager runtime secrets", () => {
  it("loads synthetic DB password and JWT signing keys from pinned LocalStack", async () => {
    setRuntimeSecretsForTest(undefined);
    const secretSuffix = randomUUID();
    const dbPasswordSecretId = `expenseflow/test/${secretSuffix}/db-password`;
    const jwtSigningKeysSecretId = `expenseflow/test/${secretSuffix}/jwt-signing-keys`;
    const jwtSigningKeys = generateJwtKeyPair();
    const config = loadApiRuntimeConfig({
      NODE_ENV: "production",
      AWS_ENDPOINT: process.env.AWS_ENDPOINT ?? "http://localhost:4566",
      AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
      DB_PASSWORD_SECRET_ID: dbPasswordSecretId,
      JWT_SIGNING_KEYS_SECRET_ID: jwtSigningKeysSecretId,
      DATABASE_URI: "postgres://expenseflow@localhost:5432/expenseflow",
      REDIS_URL: "redis://localhost:6379",
      EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: "60000",
      EXPENSE_WRITE_RATE_LIMIT_MAX: "120",
      EXPENSE_WRITE_SLOW_DOWN_AFTER: "80",
      EXPENSE_WRITE_DELAY_INCREMENT_MS: "250",
      EXPENSE_WRITE_MAX_DELAY_MS: "5000"
    });
    const client = new SecretsManagerClient({
      endpoint: config.AWS_ENDPOINT,
      region: config.AWS_REGION,
      credentials: {
        accessKeyId: "localstack",
        secretAccessKey: "localstack"
      }
    });

    try {
      await createSecret(client, dbPasswordSecretId, "synthetic-localstack-db-password");
      await createSecret(client, jwtSigningKeysSecretId, JSON.stringify(jwtSigningKeys));

      await expect(preloadRuntimeSecrets(config, client)).resolves.toEqual({
        dbPassword: "synthetic-localstack-db-password",
        jwtSigningKeys: {
          privateKeyPem: jwtSigningKeys.privateKeyPem.trim(),
          publicKeyPem: jwtSigningKeys.publicKeyPem.trim()
        }
      });
    } finally {
      await Promise.all([
        deleteSecret(client, dbPasswordSecretId),
        deleteSecret(client, jwtSigningKeysSecretId)
      ]);
    }
  });
});

async function createSecret(
  client: SecretsManagerClient,
  secretId: string,
  secretString: string
): Promise<void> {
  try {
    await client.send(
      new CreateSecretCommand({
        Name: secretId,
        SecretString: secretString
      })
    );
  } catch (error) {
    if (error instanceof ResourceExistsException) {
      return;
    }

    throw error;
  }
}

async function deleteSecret(client: SecretsManagerClient, secretId: string): Promise<void> {
  await client
    .send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true
      })
    )
    .catch(() => undefined);
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
