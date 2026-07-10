import pino, { type Logger } from "pino";
import { describe, expect, it } from "vitest";

import { sensitiveLogCensor, sensitiveLogPaths } from "./logger.js";

const rawSensitiveValues = [
  "synthetic-authorization-secret",
  "synthetic-token-secret",
  "synthetic-access-token-secret",
  "synthetic-refresh-token-secret",
  "synthetic-token-hash-secret",
  "synthetic-password-secret",
  "synthetic-credentials-secret",
  "synthetic-receipt-secret",
  "synthetic-receipt-data-secret",
  "synthetic-receipt-number-secret",
  "synthetic-receipt-email@example.test",
  "synthetic-receipt-phone-secret",
  "synthetic-receipt-address-secret",
  "synthetic-payment-secret",
  "synthetic-payment-id-secret",
  "synthetic-payment-data-secret",
  "synthetic-account-number-secret",
  "synthetic-bank-account-number-secret",
  "synthetic-card-number-secret",
  "synthetic-routing-number-secret"
];

describe("logger redaction", () => {
  it("redacts configured sensitive fields on success logs before emission", () => {
    const { logger, logLines } = createCapturedLogger();

    logger.info(createSensitiveLogPayload(), "Synthetic success log.");

    assertSensitiveValuesRedacted(logLines);
  });

  it("redacts configured sensitive fields on error logs before emission", () => {
    const { logger, logLines } = createCapturedLogger();

    logger.error(
      {
        err: new Error("Synthetic error for redaction coverage."),
        ...createSensitiveLogPayload()
      },
      "Synthetic error log."
    );

    assertSensitiveValuesRedacted(logLines);
  });
});

function createCapturedLogger(): { logger: Logger; logLines: string[] } {
  const logLines: string[] = [];
  const logger = pino(
    {
      redact: {
        paths: sensitiveLogPaths,
        censor: sensitiveLogCensor
      }
    },
    {
      write(line) {
        logLines.push(line);
      }
    }
  );

  return { logger, logLines };
}

function createSensitiveLogPayload(): Record<string, unknown> {
  return {
    authorization: "synthetic-authorization-secret",
    token: "synthetic-token-secret",
    accessToken: "synthetic-access-token-secret",
    refreshToken: "synthetic-refresh-token-secret",
    tokenHash: "synthetic-token-hash-secret",
    password: "synthetic-password-secret",
    credentials: "synthetic-credentials-secret",
    receipt: "synthetic-receipt-secret",
    receiptData: "synthetic-receipt-data-secret",
    receiptNumber: "synthetic-receipt-number-secret",
    receiptEmail: "synthetic-receipt-email@example.test",
    receiptPhone: "synthetic-receipt-phone-secret",
    receiptAddress: "synthetic-receipt-address-secret",
    payment: "synthetic-payment-secret",
    paymentId: "synthetic-payment-id-secret",
    paymentData: "synthetic-payment-data-secret",
    accountNumber: "synthetic-account-number-secret",
    bankAccountNumber: "synthetic-bank-account-number-secret",
    cardNumber: "synthetic-card-number-secret",
    routingNumber: "synthetic-routing-number-secret",
    nested: {
      token: "synthetic-token-secret",
      receiptData: "synthetic-receipt-data-secret",
      paymentId: "synthetic-payment-id-secret"
    },
    items: [
      {
        accessToken: "synthetic-access-token-secret",
        accountNumber: "synthetic-account-number-secret"
      }
    ],
    req: {
      headers: {
        authorization: "synthetic-authorization-secret"
      }
    }
  };
}

function assertSensitiveValuesRedacted(logLines: readonly string[]): void {
  const output = logLines.join("");

  for (const rawSensitiveValue of rawSensitiveValues) {
    expect(output).not.toContain(rawSensitiveValue);
  }

  expect(output).toContain(sensitiveLogCensor);
}
