import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

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
  client: SecretsManagerSender = getSecretsManagerClient(config)
): void {
  stopRuntimeSecretRefresh();
  refreshTimer = setInterval(() => {
    refreshRuntimeSecrets(config, client).catch(() => undefined);
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
  client: SecretsManagerSender = getSecretsManagerClient(config)
): Promise<boolean> {
  try {
    cachedSecrets = await fetchRuntimeSecrets(config, client);
    return true;
  } catch {
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
  const password = secretString.trim();

  if (password === "") {
    throw new Error("DB password secret must not be empty.");
  }

  return password;
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

function getSecretsManagerClient(config: ApiRuntimeConfig): SecretsManagerSender {
  secretsManagerClient ??= createSecretsManagerClient(config);

  return secretsManagerClient;
}
