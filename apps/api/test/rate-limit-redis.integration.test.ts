import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Redis } from "ioredis";
import request from "supertest";

import { createApp } from "../src/app.js";
import { issueTokenPair } from "../src/auth/tokens.js";
import type { ExpenseWriteRateLimitConfig } from "../src/config/expense-write-rate-limit.js";
import {
  createExpenseWriteRateLimiters,
  createExpenseWriteSlowDownKey,
  createExpenseWriteTokenBucketKey
} from "../src/middleware/rate-limit.js";

const redisUrl = process.env.REDIS_URL;

const tenantA = "00000000-0000-4000-8000-000000000a01";
const tenantB = "00000000-0000-4000-8000-000000000a02";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000a03";

const burstConfig: ExpenseWriteRateLimitConfig = {
  redisUrl: redisUrl ?? "redis://localhost:6379",
  expenseWriteRateLimitWindowMs: 10_000,
  expenseWriteRateLimitMax: 3,
  expenseWriteSlowDownAfter: 1,
  expenseWriteDelayIncrementMs: 35,
  expenseWriteMaxDelayMs: 90
};

const refillConfig: ExpenseWriteRateLimitConfig = {
  redisUrl: redisUrl ?? "redis://localhost:6379",
  expenseWriteRateLimitWindowMs: 120,
  expenseWriteRateLimitMax: 2,
  expenseWriteSlowDownAfter: 1,
  expenseWriteDelayIncrementMs: 0,
  expenseWriteMaxDelayMs: 0
};

const sharedBucketConfig: ExpenseWriteRateLimitConfig = {
  ...burstConfig,
  expenseWriteRateLimitWindowMs: 1_000,
  expenseWriteRateLimitMax: 2,
  expenseWriteSlowDownAfter: 1,
  expenseWriteDelayIncrementMs: 1,
  expenseWriteMaxDelayMs: 5
};

describe.skipIf(redisUrl === undefined)("Redis-backed Expense Report write rate limiter", () => {
  let redis: Redis;

  beforeEach(async () => {
    redis = createRedisClient();
    await redis.connect();
    await redis.ping();
    await deleteLimiterKeys(redis, tenantA, tenantB);
  });

  afterEach(async () => {
    await deleteLimiterKeys(redis, tenantA, tenantB);
    await redis.quit();
  });

  it("returns 429 after the per-tenant cap and does not throttle another tenant", async () => {
    const app = createRateLimitedApp(redis, burstConfig);
    const tenantAResponses = [];

    for (let index = 0; index < burstConfig.expenseWriteRateLimitMax + 1; index += 1) {
      tenantAResponses.push(await postInvalidExpenseReport(app, tenantA));
    }

    const tenantBResponse = await postInvalidExpenseReport(app, tenantB);

    expect(tenantAResponses.map((response) => response.status)).toEqual([400, 400, 400, 429]);
    expect(tenantBResponse.status).toBe(400);
  });

  it("increases response delay after the slow-down threshold before returning 429", async () => {
    const app = createRateLimitedApp(redis, burstConfig);
    const timings = [];

    timings.push(await timeInvalidExpenseReport(app, tenantA));
    timings.push(await timeInvalidExpenseReport(app, tenantA));
    timings.push(await timeInvalidExpenseReport(app, tenantA));

    const deniedResponse = await postInvalidExpenseReport(app, tenantA);

    expect(timings.map((timing) => timing.status)).toEqual([400, 400, 400]);
    expect(timings[1].elapsedMs).toBeGreaterThanOrEqual(20);
    expect(timings[2].elapsedMs).toBeGreaterThanOrEqual(timings[1].elapsedMs);
    expect(deniedResponse.status).toBe(429);
  });

  it("shares the slow-down counter across independent Redis clients", async () => {
    const secondRedis = createRedisClient();

    try {
      await secondRedis.connect();
      const firstApp = createRateLimitedApp(redis, burstConfig);
      const secondApp = createRateLimitedApp(secondRedis, burstConfig);

      const firstTiming = await timeInvalidExpenseReport(firstApp, tenantA);
      const secondTiming = await timeInvalidExpenseReport(secondApp, tenantA);

      expect(firstTiming.status).toBe(400);
      expect(secondTiming.status).toBe(400);
      expect(secondTiming.elapsedMs).toBeGreaterThanOrEqual(20);
    } finally {
      await secondRedis.quit();
    }
  });

  it("allows traffic again after the token bucket refills", async () => {
    const app = createRateLimitedApp(redis, refillConfig);

    for (let index = 0; index < refillConfig.expenseWriteRateLimitMax; index += 1) {
      expect((await postInvalidExpenseReport(app, tenantA)).status).toBe(400);
    }

    expect((await postInvalidExpenseReport(app, tenantA)).status).toBe(429);

    await sleep(refillConfig.expenseWriteRateLimitWindowMs + 40);

    expect((await postInvalidExpenseReport(app, tenantA)).status).toBe(400);
  });

  it("shares one tenant token bucket across two app instances", async () => {
    const secondRedis = createRedisClient();
    const firstApp = createRateLimitedApp(redis, sharedBucketConfig);

    try {
      await secondRedis.connect();
      const secondApp = createRateLimitedApp(secondRedis, sharedBucketConfig);
      const firstResponse = await postInvalidExpenseReport(firstApp, tenantA);
      const secondResponse = await postInvalidExpenseReport(secondApp, tenantA);
      const combinedLimitResponse = await postInvalidExpenseReport(secondApp, tenantA);

      expect(firstResponse.status).toBe(400);
      expect(secondResponse.status).toBe(400);
      expect(combinedLimitResponse.status).toBe(429);
    } finally {
      await secondRedis.quit();
    }
  });
});

function createRateLimitedApp(redis: Redis, config: ExpenseWriteRateLimitConfig) {
  return createApp({
    expenseWriteRateLimiters: createExpenseWriteRateLimiters(config, redis)
  });
}

function postInvalidExpenseReport(app: ReturnType<typeof createApp>, tenantId: string) {
  return request(app)
    .post("/expense-reports")
    .set("Authorization", createBearerToken(tenantId))
    .send({
      currentStage: "Invalid Stage"
    });
}

async function timeInvalidExpenseReport(
  app: ReturnType<typeof createApp>,
  tenantId: string
): Promise<{ status: number; elapsedMs: number }> {
  const startedAt = performance.now();
  const response = await postInvalidExpenseReport(app, tenantId);

  return {
    status: response.status,
    elapsedMs: performance.now() - startedAt
  };
}

function createBearerToken(tenantId: string): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles: ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}

async function deleteLimiterKeys(redis: Redis, ...tenantIds: string[]): Promise<void> {
  const keys = tenantIds.flatMap((tenantId) => [
    createExpenseWriteTokenBucketKey(tenantId),
    createExpenseWriteSlowDownKey(tenantId)
  ]);

  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

function getRedisUrl(): string {
  if (redisUrl === undefined) {
    throw new Error("REDIS_URL is required for Redis rate-limit integration tests.");
  }

  return redisUrl;
}

function createRedisClient(): Redis {
  return new Redis(getRedisUrl(), {
    connectTimeout: 500,
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
