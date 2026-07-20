import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import jwt from "jsonwebtoken";
import pg from "pg";

const tenantA = "00000000-0000-4000-8000-000000000701";
const tenantB = "00000000-0000-4000-8000-000000000702";
const employeeId = "synthetic-compose-employee-00000000-0000-4000-8000-000000000703";
const managerId = "synthetic-compose-manager-00000000-0000-4000-8000-000000000704";
const apiBaseUrl = process.env.COMPOSE_CORE_URL ?? "http://localhost:3000";
const computeBaseUrl = process.env.COMPOSE_COMPUTE_URL ?? "http://localhost:8000";
const pactBrokerBaseUrl = process.env.PACT_BROKER_BASE_URL ?? "http://localhost:9292";
const databaseUri =
  process.env.COMPOSE_DATABASE_URI ?? "postgres://expenseflow@localhost:5433/expenseflow";
const awsEndpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4566";
const jwtSigningKeysSecretId =
  process.env.JWT_SIGNING_KEYS_SECRET_ID ?? "expenseflow/local/jwt-signing-keys";
const reportPath = "docs/temp_test_results.md";
const commandText = "npm run compose:verify-submit-slice";

const output = [];
let exitCode = 0;

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
  output.push(`Compute health: ${await expectHealthy(`${computeBaseUrl}/health`)}`);
  output.push(
    `Pact Broker health: ${await expectHealthy(`${pactBrokerBaseUrl}/diagnostic/status/heartbeat`)}`
  );

  const jwtSigningKeys = await fetchJwtSigningKeys();
  const employeeToken = signBearer(jwtSigningKeys.privateKeyPem, tenantA, employeeId, ["Employee"]);
  const crossTenantEmployeeToken = signBearer(jwtSigningKeys.privateKeyPem, tenantB, employeeId, [
    "Employee"
  ]);
  const managerToken = signBearer(jwtSigningKeys.privateKeyPem, tenantA, managerId, [
    "Department Manager"
  ]);

  const createResponse = await postJson(`${apiBaseUrl}/v1/expense-reports`, employeeToken, {});
  expectStatus(createResponse, 201, "create Expense Report");
  const reportId = createResponse.body.id;
  if (typeof reportId !== "string") {
    throw new Error("Core create response did not include an Expense Report id.");
  }

  const lineItemId = await seedLineItem(reportId);
  output.push(`Seeded synthetic over-500 Meals line item: ${lineItemId}`);

  const crossTenantSubmit = await postJson(
    `${apiBaseUrl}/v1/expense-reports/${reportId}/submit`,
    crossTenantEmployeeToken,
    {},
    { "Idempotency-Key": `compose-cross-tenant-${Date.now()}` }
  );
  expectStatus(crossTenantSubmit, 404, "cross-tenant submit");
  output.push("Cross-tenant submit rejected with HTTP 404.");

  const submitResponse = await postJson(
    `${apiBaseUrl}/v1/expense-reports/${reportId}/submit`,
    employeeToken,
    {},
    { "Idempotency-Key": `compose-submit-${Date.now()}` }
  );
  expectStatus(submitResponse, 200, "tenant submit");
  if (submitResponse.body.currentStage !== "Submitted") {
    throw new Error(
      `Expected submit stage Submitted, received ${submitResponse.body.currentStage}`
    );
  }

  const codedLineItem = await readLineItem(lineItemId);
  const codedExpectation = {
    flagged: true,
    flag_cleared: false,
    gl_coding_status: "mapped",
    gl_account_code: "6100",
    gl_account_name: "Synthetic Meals Expense",
    gl_normal_balance: "debit"
  };
  for (const [key, value] of Object.entries(codedExpectation)) {
    if (codedLineItem[key] !== value) {
      throw new Error(`Expected ${key}=${String(value)}, received ${String(codedLineItem[key])}`);
    }
  }
  output.push(
    "Submit produced persisted GL coding through composed Core -> Compute: stage=Submitted, gl_account_code=6100, flagged=true."
  );

  const managerAdvance = await postJson(
    `${apiBaseUrl}/v1/expense-reports/${reportId}/advance`,
    managerToken,
    { reason: "Synthetic compose manager review." },
    { "Idempotency-Key": `compose-manager-advance-${Date.now()}` }
  );
  expectStatus(managerAdvance, 200, "advance to Manager Approval");
  if (managerAdvance.body.currentStage !== "Manager Approval") {
    throw new Error(
      `Expected Manager Approval after first advance, received ${managerAdvance.body.currentStage}`
    );
  }

  const blockedAdvance = await postJson(
    `${apiBaseUrl}/v1/expense-reports/${reportId}/advance`,
    managerToken,
    {},
    { "Idempotency-Key": `compose-flag-block-${Date.now()}` }
  );
  expectStatus(blockedAdvance, 409, "flag-gated Manager Approval advance");
  output.push("Flagged report was blocked from advancing past Manager Approval with HTTP 409.");
  output.push("Compose submit slice verification passed.");
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

function signBearer(privateKeyPem, tenantId, userId, roles) {
  const accessToken = jwt.sign(
    {
      tenantId,
      roles
    },
    privateKeyPem,
    {
      algorithm: "RS256",
      keyid: "local-development-key",
      issuer: "expense-api",
      audience: "expense-clients",
      expiresIn: "15m",
      subject: userId
    }
  );

  return `Bearer ${accessToken}`;
}

async function seedLineItem(reportId) {
  const client = new pg.Client({ connectionString: databaseUri });
  await client.connect();
  try {
    const result = await client.query(
      `
      insert into expense_line_item (
        tenant_id,
        expense_report_id,
        merchant,
        amount_cents,
        currency,
        category
      )
      values ($1::uuid, $2::uuid, 'Synthetic Compose Team Meal', 50001, 'USD', 'Meals')
      returning id
      `,
      [tenantA, reportId]
    );

    return result.rows[0].id;
  } finally {
    await client.end();
  }
}

async function readLineItem(lineItemId) {
  const client = new pg.Client({ connectionString: databaseUri });
  await client.connect();
  try {
    const result = await client.query(
      `
      select
        flagged,
        flag_cleared,
        gl_coding_status,
        gl_account_code,
        gl_account_name,
        gl_normal_balance
      from expense_line_item
      where tenant_id = $1::uuid and id = $2::uuid
      `,
      [tenantA, lineItemId]
    );

    if (result.rowCount !== 1) {
      throw new Error(`Expected one line item row, found ${result.rowCount}.`);
    }

    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function postJson(url, bearerToken, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: bearerToken,
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    body: await response.json().catch(() => ({}))
  };
}

async function expectHealthy(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }

  return `HTTP ${response.status}`;
}

function expectStatus(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(
      `${label} expected HTTP ${expectedStatus}, received HTTP ${response.status}: ${JSON.stringify(
        response.body
      )}`
    );
  }
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
    `${prefix}# Compose Submit Slice Results`,
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
