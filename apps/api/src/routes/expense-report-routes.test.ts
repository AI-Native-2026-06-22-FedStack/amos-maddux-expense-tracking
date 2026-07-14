import { RequestHandler } from "express";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { issueTokenPair } from "../auth/tokens.js";

const tenantId = "00000000-0000-4000-8000-000000000901";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000902";

describe("Expense Report route rate-limit wiring", () => {
  it("rejects unauthenticated write requests before rate limiters run", async () => {
    let limiterCalled = false;
    const app = createApp({
      expenseWriteRateLimiters: [
        (_request, _response, next) => {
          limiterCalled = true;
          next();
        }
      ]
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(limiterCalled).toBe(false);
  });

  it("runs write slow-down before the hard limiter and before the controller", async () => {
    const sequence: string[] = [];
    const slowDownLimiter: RequestHandler = (_request, _response, next) => {
      sequence.push("slow-down");
      next();
    };
    const hardLimiter: RequestHandler = (_request, response) => {
      sequence.push("hard-limit");
      response.status(429).json({ error: "Synthetic limiter response." });
    };
    const app = createApp({
      expenseWriteRateLimiters: [slowDownLimiter, hardLimiter]
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {
        currentStage: "Invalid Stage"
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "Synthetic limiter response." });
    expect(sequence).toEqual(["slow-down", "hard-limit"]);
  });

  it("does not apply write limiters to Expense Report reads", async () => {
    let limiterCalled = false;
    const app = createApp({
      expenseWriteRateLimiters: [
        (_request, response) => {
          limiterCalled = true;
          response.status(429).json({ error: "Synthetic limiter response." });
        }
      ]
    });

    const response = await inject(app, {
      method: "GET",
      url: "/expense-reports/not-a-uuid",
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(response.statusCode).toBe(400);
    expect(limiterCalled).toBe(false);
  });

  it.each([
    { method: "GET" as const, url: "/health", statusCode: 200 },
    { method: "GET" as const, url: "/docs", statusCode: 200 },
    { method: "POST" as const, url: "/auth/login", statusCode: 400, payload: {} }
  ])("does not apply write limiters to $method $url", async ({ method, url, statusCode, payload }) => {
    let limiterCalled = false;
    const app = createApp({
      expenseWriteRateLimiters: [
        (_request, response) => {
          limiterCalled = true;
          response.status(429).json({ error: "Synthetic limiter response." });
        }
      ]
    });

    const response = await inject(app, {
      method,
      url,
      ...(payload === undefined ? {} : { payload })
    });

    expect(response.statusCode).toBe(statusCode);
    expect(limiterCalled).toBe(false);
  });
});

function createAuthorizationHeader(): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles: ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}
