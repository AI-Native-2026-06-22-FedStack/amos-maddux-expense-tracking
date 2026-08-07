import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import pg from "pg";

const tenantA = "00000000-0000-4000-8000-000000000701";
const localUserEmail = "synthetic.local.finance@example.test";
const apiBaseUrl = process.env.COMPOSE_CORE_URL ?? "http://localhost:3000";
const databaseUri =
  process.env.COMPOSE_DATABASE_URI ??
  "postgres://expenseflow:synthetic-compose-db-password@localhost:5433/expenseflow";
const awsEndpoint =
  process.env.AWS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT ?? "http://localhost:4566";
const jwtSigningKeysSecretId =
  process.env.JWT_SIGNING_KEYS_SECRET_ID ?? "expenseflow/local/jwt-signing-keys";
const reportPath = "docs/temp_test_results.md";
const commandText = "npm run compose:verify-submit-slice";

const output = [];
let exitCode = 0;
const expectedSeedCounts = {
  roles: 1,
  users: 1,
  credentials: 1,
  mfa: 1,
  gl_codes: 1,
  gl_mappings: 1
};

try {
  await run();
} catch (error) {
  exitCode = 1;
  output.push(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await appendResults(exitCode, output);
}

if (exitCode !== 0) {
  process.exit(exitCode);
}

async function run() {
  output.push(`Core health: ${await expectHealthy(`${apiBaseUrl}/health`)}`);

  const localUserId = await readLocalUserId();
  output.push(`Synthetic local user present: ${localUserId}`);
  await fetchJwtSigningKeys();
  output.push(`JWT signing key secret resolved through ${awsEndpoint}.`);
  const seedState = await readSeedState();
  assertSeedState(seedState);
  output.push(`Seeded relational state: ${JSON.stringify(seedState)}`);
  output.push("Compose stack verification passed.");
}

async function fetchJwtSigningKeys() {
  const client = new SecretsManagerClient({
    endpoint: awsEndpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: "local",
      secretAccessKey: "local"
    }
  });
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: jwtSigningKeysSecretId
    })
  );
  if (response.SecretString === undefined) {
    throw new Error(`Missing SecretString for ${jwtSigningKeysSecretId}.`);
  }

  return JSON.parse(response.SecretString);
}

async function readLocalUserId() {
  const client = new pg.Client({ connectionString: databaseUri });
  await client.connect();
  try {
    const result = await client.query(
      `
      select id
      from "user"
      where tenant_id = $1::uuid and email = $2
      `,
      [tenantA, localUserEmail]
    );

    if (result.rowCount !== 1 || typeof result.rows[0]?.id !== "string") {
      throw new Error(`Expected one synthetic local user for ${localUserEmail}.`);
    }

    return result.rows[0].id;
  } finally {
    await client.end();
  }
}

async function readSeedState() {
  const client = new pg.Client({ connectionString: databaseUri });
  await client.connect();
  try {
    const result = await client.query(
      `
      select
        (select count(*)::int from role where tenant_id = $1::uuid) as roles,
        (select count(*)::int from "user" where tenant_id = $1::uuid and email = $2) as users,
        (select count(*)::int from credential where tenant_id = $1::uuid) as credentials,
        (select count(*)::int from mfa_enrollment where tenant_id = $1::uuid) as mfa,
        (select count(*)::int from gl_code where tenant_id = $1::uuid and account_code = '6100') as gl_codes,
        (select count(*)::int from gl_mapping where tenant_id = $1::uuid and category = 'Meals') as gl_mappings
      `,
      [tenantA, localUserEmail]
    );

    if (result.rowCount !== 1) {
      throw new Error("Seed state query did not return a row.");
    }

    return result.rows[0];
  } finally {
    await client.end();
  }
}

function assertSeedState(seedState) {
  for (const [key, expectedValue] of Object.entries(expectedSeedCounts)) {
    if (seedState[key] !== expectedValue) {
      throw new Error(`Expected ${key} seed count ${expectedValue}, received ${seedState[key]}.`);
    }
  }
}

async function expectHealthy(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return `HTTP ${response.status}`;
}

async function appendResults(exitCodeToRecord, lines) {
  await mkdir(dirname(reportPath), { recursive: true });
  let previous = "";
  try {
    previous = await readFile(reportPath, "utf8");
  } catch {
    previous = "";
  }
  const prefix = previous.endsWith("\n") || previous.length === 0 ? "" : "\n";
  const section = [
    `${prefix}# Compose Stack Smoke Results`,
    "",
    "```sh",
    commandText,
    "```",
    "",
    "```text",
    ...lines,
    `Exit code: ${exitCodeToRecord}`,
    "```",
    ""
  ].join("\n");

  await appendFile(reportPath, section);
}
