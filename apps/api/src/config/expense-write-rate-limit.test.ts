import { describe, expect, it } from "vitest";

import { loadJwtRuntimeConfig } from "../auth/tokens.js";
import { loadExpenseWriteRateLimitConfig } from "./expense-write-rate-limit.js";

const validEnvironment = {
  REDIS_URL: "redis://localhost:6379",
  EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: "60000",
  EXPENSE_WRITE_RATE_LIMIT_MAX: "120",
  EXPENSE_WRITE_SLOW_DOWN_AFTER: "80",
  EXPENSE_WRITE_DELAY_INCREMENT_MS: "250",
  EXPENSE_WRITE_MAX_DELAY_MS: "5000"
};

describe("loadExpenseWriteRateLimitConfig", () => {
  it("parses valid Expense Report write limiter values", () => {
    expect(loadExpenseWriteRateLimitConfig(validEnvironment)).toEqual({
      redisUrl: "redis://localhost:6379",
      expenseWriteRateLimitWindowMs: 60_000,
      expenseWriteRateLimitMax: 120,
      expenseWriteSlowDownAfter: 80,
      expenseWriteDelayIncrementMs: 250,
      expenseWriteMaxDelayMs: 5_000
    });
  });

  it.each([
    "REDIS_URL",
    "EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS",
    "EXPENSE_WRITE_RATE_LIMIT_MAX",
    "EXPENSE_WRITE_SLOW_DOWN_AFTER",
    "EXPENSE_WRITE_DELAY_INCREMENT_MS",
    "EXPENSE_WRITE_MAX_DELAY_MS"
  ])("fails clearly when %s is missing", (name) => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        [name]: undefined
      })
    ).toThrow(name);
  });

  it.each([
    "EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS",
    "EXPENSE_WRITE_RATE_LIMIT_MAX",
    "EXPENSE_WRITE_SLOW_DOWN_AFTER",
    "EXPENSE_WRITE_DELAY_INCREMENT_MS",
    "EXPENSE_WRITE_MAX_DELAY_MS"
  ])("fails clearly when %s is non-numeric", (name) => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        [name]: "not-a-number"
      })
    ).toThrow(name);
  });

  it.each([
    ["EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS", "0"],
    ["EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS", "-1"],
    ["EXPENSE_WRITE_RATE_LIMIT_MAX", "0"],
    ["EXPENSE_WRITE_RATE_LIMIT_MAX", "-1"],
    ["EXPENSE_WRITE_SLOW_DOWN_AFTER", "0"],
    ["EXPENSE_WRITE_SLOW_DOWN_AFTER", "-1"],
    ["EXPENSE_WRITE_DELAY_INCREMENT_MS", "-1"],
    ["EXPENSE_WRITE_MAX_DELAY_MS", "-1"]
  ])("fails clearly when %s is %s", (name, value) => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        [name]: value
      })
    ).toThrow(name);
  });

  it.each([
    ["EXPENSE_WRITE_DELAY_INCREMENT_MS", "60001"],
    ["EXPENSE_WRITE_MAX_DELAY_MS", "60001"]
  ])("fails clearly when %s is above the configured bound", (name, value) => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        [name]: value
      })
    ).toThrow(name);
  });

  it("fails when the slow-down threshold is equal to the hard cap", () => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        EXPENSE_WRITE_RATE_LIMIT_MAX: "80",
        EXPENSE_WRITE_SLOW_DOWN_AFTER: "80"
      })
    ).toThrow("EXPENSE_WRITE_SLOW_DOWN_AFTER");
  });

  it("fails when the slow-down threshold is greater than the hard cap", () => {
    expect(() =>
      loadExpenseWriteRateLimitConfig({
        ...validEnvironment,
        EXPENSE_WRITE_RATE_LIMIT_MAX: "80",
        EXPENSE_WRITE_SLOW_DOWN_AFTER: "81"
      })
    ).toThrow("EXPENSE_WRITE_SLOW_DOWN_AFTER");
  });

  it("does not break existing JWT runtime configuration parsing", () => {
    const config = loadJwtRuntimeConfig();

    expect(config).toMatchObject({
      issuer: "expense-api",
      audience: "expense-clients",
      keyId: "local-development-key",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      privateKeyPem: expect.stringContaining("PRIVATE KEY"),
      publicKeyPem: expect.stringContaining("PUBLIC KEY")
    });
  });
});
