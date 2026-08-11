import { describe, expect, it } from "vitest";

import { loadApiRuntimeConfig } from "./runtime-config.js";

const validEnvironment = {
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
  API_CORS_ALLOWED_ORIGIN: "http://expenseflow-spa.test",
  EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: "60000",
  EXPENSE_WRITE_RATE_LIMIT_MAX: "120",
  EXPENSE_WRITE_SLOW_DOWN_AFTER: "80",
  EXPENSE_WRITE_DELAY_INCREMENT_MS: "250",
  EXPENSE_WRITE_MAX_DELAY_MS: "5000"
};

describe("loadApiRuntimeConfig", () => {
  it("strictly parses valid non-secret runtime configuration", () => {
    expect(loadApiRuntimeConfig(validEnvironment)).toMatchObject({
      AWS_ENDPOINT: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      SNS_STAGE_EVENTS_TOPIC: "expenseflow-stage-events",
      SQS_STAGE_EVENTS_QUEUE: "expenseflow-stage-projection",
      SQS_STAGE_EVENTS_DLQ: "expenseflow-stage-projection-dlq",
      DB_PASSWORD_SECRET_ID: "expenseflow/local/db-password",
      JWT_SIGNING_KEYS_SECRET_ID: "expenseflow/local/jwt-signing-keys",
      DATABASE_URI: "postgres://expenseflow@localhost:5432/expenseflow",
      REDIS_URL: "redis://localhost:6379",
      API_CORS_ALLOWED_ORIGIN: "http://expenseflow-spa.test",
      PORT: 3000,
      TIVS_ACL_URL: "http://localhost:3015",
      JWT_ACCESS_TOKEN_TTL_SECONDS: 900,
      JWT_REFRESH_TOKEN_TTL_SECONDS: 2_592_000
    });
  });

  it.each([
    ["AWS_ENDPOINT", "not-a-url"],
    ["SNS_STAGE_EVENTS_TOPIC", ""],
    ["SQS_STAGE_EVENTS_QUEUE", ""],
    ["SQS_STAGE_EVENTS_DLQ", ""],
    ["DATABASE_URI", "http://localhost:5432/expenseflow"],
    ["REDIS_URL", "http://localhost:6379"],
    ["API_CORS_ALLOWED_ORIGIN", "not-a-url"],
    ["PORT", "70000"],
    ["JWT_ACCESS_TOKEN_TTL_SECONDS", "0"],
    ["JWT_REFRESH_TOKEN_TTL_SECONDS", "not-a-number"]
  ])("fails fast when %s is invalid", (name, value) => {
    expect(() =>
      loadApiRuntimeConfig({
        ...validEnvironment,
        [name]: value
      })
    ).toThrow();
  });

  it.each([
    "AWS_ENDPOINT",
    "SNS_STAGE_EVENTS_TOPIC",
    "SQS_STAGE_EVENTS_QUEUE",
    "SQS_STAGE_EVENTS_DLQ",
    "DB_PASSWORD_SECRET_ID",
    "JWT_SIGNING_KEYS_SECRET_ID",
    "API_CORS_ALLOWED_ORIGIN"
  ])("fails fast when %s is missing", (name) => {
    expect(() =>
      loadApiRuntimeConfig({
        ...validEnvironment,
        [name]: undefined
      })
    ).toThrow();
  });

  it("rejects a non-test DATABASE_URI with an embedded password", () => {
    const databaseUri = new URL(validEnvironment.DATABASE_URI);
    databaseUri.password = "synthetic-password";

    expect(() =>
      loadApiRuntimeConfig({
        ...validEnvironment,
        DATABASE_URI: databaseUri.toString()
      })
    ).toThrow("DATABASE_URI");
  });
});
