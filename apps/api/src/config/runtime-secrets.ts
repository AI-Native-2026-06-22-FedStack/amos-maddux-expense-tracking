import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig
} from "@aws-sdk/client-secrets-manager";
import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";

import { logger as rootLogger } from "../logger.js";
import { ApiRuntimeConfig, getApiRuntimeConfig } from "./runtime-config.js";

export const runtimeSecretRefreshIntervalMs = 5 * 60 * 1000;

const jwtSigningKeysSchema = z.object({
  privateKeyPem: z.string().trim().min(1),
  publicKeyPem: z.string().trim().min(1)
});

export interface JwtSigningKeys {
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface RuntimeSecrets {
  dbPassword: string;
  jwtSigningKeys: JwtSigningKeys;
}

export interface SecretsManagerSender {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

let secretsManagerClient: SecretsManagerSender | undefined;
let cachedSecrets: RuntimeSecrets | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight: Promise<boolean> | undefined;

interface RuntimeSecretRefreshOptions {
  logger?: Pick<Logger, "debug" | "warn">;
}

export function createSecretsManagerClient(config: ApiRuntimeConfig): SecretsManagerClient {
  const clientConfig: SecretsManagerClientConfig = {
    endpoint: config.AWS_ENDPOINT,
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: "localstack",
      secretAccessKey: "localstack"
    }
  };

  return new SecretsManagerClient(clientConfig);
}

export async function preloadRuntimeSecrets(
  config: ApiRuntimeConfig = getApiRuntimeConfig(),
  client: SecretsManagerSender = getSecretsManagerClient(config)
): Promise<RuntimeSecrets> {
  const secrets = await fetchRuntimeSecrets(config, client);
  cachedSecrets = secrets;

  return secrets;
}

export function getRuntimeSecrets(): RuntimeSecrets {
  if (cachedSecrets === undefined) {
    throw new Error("Runtime secrets have not been preloaded.");
  }

  return cachedSecrets;
}

export function startRuntimeSecretRefresh(
  config: ApiRuntimeConfig = getApiRuntimeConfig(),
  client: SecretsManagerSender = getSecretsManagerClient(config),
  options: RuntimeSecretRefreshOptions = {}
): void {
  stopRuntimeSecretRefresh();
  refreshTimer = setInterval(() => {
    refreshRuntimeSecrets(config, client, options).catch(() => undefined);
  }, runtimeSecretRefreshIntervalMs);
  refreshTimer.unref?.();
}

export function stopRuntimeSecretRefresh(): void {
  if (refreshTimer === undefined) {
    return;
  }

  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

export async function refreshRuntimeSecrets(
  config: ApiRuntimeConfig = getApiRuntimeConfig(),
  client: SecretsManagerSender = getSecretsManagerClient(config),
  options: RuntimeSecretRefreshOptions = {}
): Promise<boolean> {
  if (refreshInFlight !== undefined) {
    return refreshInFlight;
  }

  refreshInFlight = refreshRuntimeSecretsOnce(config, client, options).finally(() => {
    refreshInFlight = undefined;
  });

  return refreshInFlight;
}

async function refreshRuntimeSecretsOnce(
  config: ApiRuntimeConfig,
  client: SecretsManagerSender,
  options: RuntimeSecretRefreshOptions
): Promise<boolean> {
  const refreshLogger = options.logger ?? rootLogger;

  try {
    cachedSecrets = await fetchRuntimeSecrets(config, client);
    refreshLogger.debug("Runtime secrets refreshed successfully.");
    return true;
  } catch (error) {
    refreshLogger.warn(
      {
        err: error,
        dbPasswordSecretId: config.DB_PASSWORD_SECRET_ID,
        jwtSigningKeysSecretId: config.JWT_SIGNING_KEYS_SECRET_ID
      },
      "Runtime secret refresh failed; keeping last valid cached secrets."
    );
    return false;
  }
}

export function setRuntimeSecretsForTest(secrets: RuntimeSecrets | undefined): void {
  cachedSecrets = secrets;
}

export function setSecretsManagerClientForTest(client: SecretsManagerSender | undefined): void {
  secretsManagerClient = client;
}

async function fetchRuntimeSecrets(
  config: ApiRuntimeConfig,
  client: SecretsManagerSender
): Promise<RuntimeSecrets> {
  const [dbPassword, jwtSigningKeys] = await Promise.all([
    fetchDbPassword(config, client),
    fetchJwtSigningKeys(config, client)
  ]);

  return {
    dbPassword,
    jwtSigningKeys
  };
}

async function fetchDbPassword(
  config: ApiRuntimeConfig,
  client: SecretsManagerSender
): Promise<string> {
  const secretString = await fetchRequiredSecretString(client, config.DB_PASSWORD_SECRET_ID);

  if (secretString.trim() === "") {
    throw new Error("DB password secret must not be empty.");
  }

  return secretString;
}

async function fetchJwtSigningKeys(
  config: ApiRuntimeConfig,
  client: SecretsManagerSender
): Promise<JwtSigningKeys> {
  const secretString = await fetchRequiredSecretString(client, config.JWT_SIGNING_KEYS_SECRET_ID);
  const parsedJson: unknown = JSON.parse(secretString);
  const keys = jwtSigningKeysSchema.parse(parsedJson);

  assertPemKind(keys.privateKeyPem, "PRIVATE KEY", "JWT private key");
  assertPemKind(keys.publicKeyPem, "PUBLIC KEY", "JWT public key");
  assertJwtKeyPair(keys);

  return keys;
}

async function fetchRequiredSecretString(
  client: SecretsManagerSender,
  secretId: string
): Promise<string> {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (response.SecretString === undefined || response.SecretString.trim() === "") {
    throw new Error(`SecretString is required for ${secretId}.`);
  }

  return response.SecretString;
}

function assertPemKind(value: string, expectedLabel: string, description: string): void {
  const trimmedValue = value.trim();

  if (
    !trimmedValue.startsWith(`-----BEGIN ${expectedLabel}-----`) ||
    !trimmedValue.endsWith(`-----END ${expectedLabel}-----`)
  ) {
    throw new Error(`${description} must be a PEM encoded ${expectedLabel}.`);
  }
}

function assertJwtKeyPair(keys: JwtSigningKeys): void {
  try {
    const privateKey = createPrivateKey(keys.privateKeyPem);
    const publicKey = createPublicKey(keys.publicKeyPem);
    const payload = "expenseflow-runtime-secret-validation";
    const signature = createSign("RSA-SHA256").update(payload).end().sign(privateKey);
    const verified = createVerify("RSA-SHA256").update(payload).end().verify(publicKey, signature);

    if (!verified) {
      throw new Error("JWT private and public keys do not match.");
    }
  } catch (error) {
    throw new Error("JWT signing key secret must contain a valid matching RSA key pair.", {
      cause: error
    });
  }
}

function getSecretsManagerClient(config: ApiRuntimeConfig): SecretsManagerSender {
  secretsManagerClient ??= createSecretsManagerClient(config);

  return secretsManagerClient;
}
