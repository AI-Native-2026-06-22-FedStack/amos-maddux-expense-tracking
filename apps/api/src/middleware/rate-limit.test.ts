import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { type ExpenseWriteRateLimitConfig } from "../config/expense-write-rate-limit.js";
import { problemJsonErrorHandler } from "../errors/problem-json.js";
import {
  type RedisEvalClient,
  createExpenseWriteTokenBucketKey,
  createExpenseWriteTokenBucketRateLimiter
} from "./rate-limit.js";

const tenantA = "00000000-0000-4000-8000-000000000801";
const tenantB = "00000000-0000-4000-8000-000000000802";

const config: ExpenseWriteRateLimitConfig = {
  redisUrl: "redis://localhost:6379",
  expenseWriteRateLimitWindowMs: 60_000,
  expenseWriteRateLimitMax: 120,
  expenseWriteSlowDownAfter: 80,
  expenseWriteDelayIncrementMs: 250,
  expenseWriteMaxDelayMs: 5_000
};

interface RedisEvalCall {
  script: string;
  numberOfKeys: number;
  args: string[];
}

class FakeRedis implements RedisEvalClient {
  public readonly calls: RedisEvalCall[] = [];

  public constructor(private readonly responses: unknown[]) {}

  public async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
    this.calls.push({ script, numberOfKeys, args });
    const response = this.responses.shift();

    if (response instanceof Error) {
      throw response;
    }

    return response ?? [1, 0, 119];
  }
}

describe("createExpenseWriteTokenBucketRateLimiter", () => {
  it("allows a request when the Redis token bucket has capacity", async () => {
    const redis = new FakeRedis([[1, 0, 119]]);
    const app = createSyntheticApp(redis, tenantA);

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(response.statusCode).toBe(204);
    expect(redis.calls).toHaveLength(1);
  });

  it("returns 429 without running downstream handlers when the bucket is empty", async () => {
    const redis = new FakeRedis([[0, 1_250, 0]]);
    const app = createSyntheticApp(redis, tenantA);

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toEqual({
      type: "/problems/rate-limit-exceeded",
      title: "Too Many Requests",
      status: 429,
      detail: "Expense Report write rate limit exceeded.",
      instance: "/expense-reports"
    });
  });

  it("calls Redis eval once with the token bucket script, tenant key, and numeric config", async () => {
    const redis = new FakeRedis([[1, 0, 119]]);
    const app = createSyntheticApp(redis, tenantA, 1_700_000_000_000);

    await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(redis.calls).toEqual([
      {
        script: expect.stringContaining('redis.call("HMGET"'),
        numberOfKeys: 1,
        args: [
          createExpenseWriteTokenBucketKey(tenantA),
          String(config.expenseWriteRateLimitMax),
          String(config.expenseWriteRateLimitWindowMs),
          "1700000000000"
        ]
      }
    ]);
  });

  it("uses a different Redis token bucket key for each tenant", async () => {
    const tenantARedis = new FakeRedis([[1, 0, 119]]);
    const tenantBRedis = new FakeRedis([[1, 0, 119]]);

    await inject(createSyntheticApp(tenantARedis, tenantA), {
      method: "POST",
      url: "/expense-reports"
    });
    await inject(createSyntheticApp(tenantBRedis, tenantB), {
      method: "POST",
      url: "/expense-reports"
    });

    expect(tenantARedis.calls[0]?.args[0]).toBe(createExpenseWriteTokenBucketKey(tenantA));
    expect(tenantBRedis.calls[0]?.args[0]).toBe(createExpenseWriteTokenBucketKey(tenantB));
    expect(tenantARedis.calls[0]?.args[0]).not.toBe(tenantBRedis.calls[0]?.args[0]);
  });

  it("allows a later request after Redis reports the token bucket refilled", async () => {
    const redis = new FakeRedis([
      [0, 500, 0],
      [1, 0, 1]
    ]);
    const app = createSyntheticApp(redis, tenantA);

    const deniedResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });
    const allowedResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(deniedResponse.statusCode).toBe(429);
    expect(allowedResponse.statusCode).toBe(204);
    expect(redis.calls).toHaveLength(2);
  });

  it("passes Redis script errors to the Express error pipeline", async () => {
    const redis = new FakeRedis([new Error("Synthetic Redis failure.")]);
    const app = createSyntheticApp(redis, tenantA);

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "/problems/internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected server error occurred.",
      instance: "/expense-reports"
    });
  });

  it("passes missing auth context errors to the Express error pipeline", async () => {
    const redis = new FakeRedis([[1, 0, 119]]);
    const app = createSyntheticApp(redis);

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Missing authenticated request context.",
      instance: "/expense-reports"
    });
    expect(redis.calls).toHaveLength(0);
  });

  it("emits draft-8 RateLimit headers that decrement across allowed requests", async () => {
    const redis = new FakeRedis([
      [1, 0, 119],
      [1, 0, 118]
    ]);
    const app = createSyntheticApp(redis, tenantA);

    const firstResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });
    const secondResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(firstResponse.headers.ratelimit).toBe('"expense-write";r=119;t=60');
    expect(firstResponse.headers["ratelimit-policy"]).toBe('"expense-write";q=120;w=60');
    expect(secondResponse.headers.ratelimit).toBe('"expense-write";r=118;t=60');
  });

  it("does not emit legacy X-RateLimit headers", async () => {
    const redis = new FakeRedis([[1, 0, 119]]);
    const app = createSyntheticApp(redis, tenantA);

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports"
    });

    expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeUndefined();
    expect(response.headers["x-ratelimit-reset"]).toBeUndefined();
  });
});

function createSyntheticApp(redis: RedisEvalClient, tenantId?: string, nowMs = 1_700_000_000_000) {
  const app = express();

  if (tenantId !== undefined) {
    app.use(bindSyntheticAuthContext(tenantId));
  }

  app.post(
    "/expense-reports",
    createExpenseWriteTokenBucketRateLimiter(config, redis, {
      nowMs: () => nowMs
    }),
    (_request, response) => {
      response.status(204).end();
    }
  );
  app.use(problemJsonErrorHandler);
  app.use(errorHandler);

  return app;
}

function bindSyntheticAuthContext(tenantId: string): RequestHandler {
  return (request, _response, next) => {
    request.authContext = {
      tenantId,
      userId: "synthetic-user-00000000-0000-4000-8000-000000000803",
      roles: ["Employee"]
    };
    next();
  };
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const message = error instanceof Error ? error.message : "Synthetic unknown error.";

  response.status(500).json({ message });
};
