import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach } from "vitest";

import pg from "pg";

import { setApiRuntimeConfigForTest } from "../../src/config/runtime-config.js";
import { setRuntimeSecretsForTest } from "../../src/config/runtime-secrets.js";

const { Client } = pg;
const syntheticDbPassword = "synthetic-test-db-password";
const syntheticJwtKeyPair = generateKeyPairSync("rsa", {
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

const truncateDatabaseSql = `
TRUNCATE
    auth_audit_entry,
    credential,
    mfa_enrollment,
    refresh_token,
    "user",
    "role",
    audit_entry,
    event_outbox,
    stage_transition,
    expense_report,
    expense_line_item,
    attachment_metadata,
    receipt,
    mileage_entry
RESTART IDENTITY CASCADE;
`;

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.AWS_ENDPOINT ??= "http://localhost:4566";
  process.env.AWS_REGION ??= "us-east-1";
  process.env.SNS_STAGE_EVENTS_TOPIC ??= "expenseflow-stage-events";
  process.env.SQS_STAGE_EVENTS_QUEUE ??= "expenseflow-stage-projection";
  process.env.SQS_STAGE_EVENTS_DLQ ??= "expenseflow-stage-projection-dlq";
  process.env.DB_PASSWORD_SECRET_ID ??= "expenseflow/test/db-password";
  process.env.JWT_SIGNING_KEYS_SECRET_ID ??= "expenseflow/test/jwt-signing-keys";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  process.env.API_CORS_ALLOWED_ORIGIN ??= "http://expenseflow-spa.test";
  process.env.EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS ??= "60000";
  process.env.EXPENSE_WRITE_RATE_LIMIT_MAX ??= "120";
  process.env.EXPENSE_WRITE_SLOW_DOWN_AFTER ??= "80";
  process.env.EXPENSE_WRITE_DELAY_INCREMENT_MS ??= "250";
  process.env.EXPENSE_WRITE_MAX_DELAY_MS ??= "5000";
  setApiRuntimeConfigForTest(undefined);
  setRuntimeSecretsForTest({
    dbPassword: syntheticDbPassword,
    jwtSigningKeys: {
      privateKeyPem: syntheticJwtKeyPair.privateKey,
      publicKeyPem: syntheticJwtKeyPair.publicKey
    }
  });
});

afterEach(async () => {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for API integration test cleanup.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URI });

  try {
    await client.connect();
    await client.query(truncateDatabaseSql);
  } finally {
    await client.end();
  }
});
