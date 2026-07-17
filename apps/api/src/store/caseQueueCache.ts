import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

import type { AuthenticatedRequestContext } from "../auth/verifier.js";
import { expenseReportStages } from "../db/schema.js";
import type { CaseQueueStageSummary } from "../repository/case-queue.js";
import { queryTenantCases, type CaseQueueDynamoQueryClient } from "./dynamo.js";

export const caseQueueRollupCacheTtlSeconds = 60;
export const caseQueueRollupRebuildLockMs = 5_000;

const cacheKeyPrefix = "case-queue:rollup:";
const lockKeyPrefix = "case-queue:rollup-lock:";
const lockRetryDelayMs = 25;
const lockRetryAttempts = 40;
const rebuildLockAttemptLimit = 2;
const releaseLockScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

export type CaseQueueRollup = readonly CaseQueueStageSummary[];

export interface CaseQueueRollupRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<"OK" | null>;
  del(key: string): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export function toCaseQueueRollupRedisClient(redis: Redis): CaseQueueRollupRedisClient {
  return redis;
}

export async function readCaseQueueRollupWithCache(
  redis: CaseQueueRollupRedisClient,
  dynamo: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">
): Promise<CaseQueueRollup> {
  validateTenantId(authContext.tenantId);

  const cacheKey = createCaseQueueRollupCacheKey(authContext.tenantId);
  const cachedRollup = await readCachedRollup(redis, cacheKey);

  if (cachedRollup !== null) {
    return cachedRollup;
  }

  return rebuildRollupWithStampedeGuard(redis, dynamo, authContext, cacheKey);
}

export async function invalidateCaseQueueRollupCache(
  redis: Pick<CaseQueueRollupRedisClient, "del">,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">
): Promise<void> {
  validateTenantId(authContext.tenantId);
  await redis.del(createCaseQueueRollupCacheKey(authContext.tenantId));
}

export function createCaseQueueRollupCacheKey(tenantId: string): string {
  validateTenantId(tenantId);
  return `${cacheKeyPrefix}${tenantId}`;
}

export function createCaseQueueRollupLockKey(tenantId: string): string {
  validateTenantId(tenantId);
  return `${lockKeyPrefix}${tenantId}`;
}

async function rebuildRollupWithStampedeGuard(
  redis: CaseQueueRollupRedisClient,
  dynamo: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">,
  cacheKey: string
): Promise<CaseQueueRollup> {
  const lockKey = createCaseQueueRollupLockKey(authContext.tenantId);

  for (let attempt = 0; attempt < rebuildLockAttemptLimit; attempt += 1) {
    const lockValue = randomUUID();
    const acquiredLock = await redis.set(
      lockKey,
      lockValue,
      "PX",
      caseQueueRollupRebuildLockMs,
      "NX"
    );

    if (acquiredLock === "OK") {
      try {
        const rollup = await readRollupFromDynamo(dynamo, authContext);
        await writeCachedRollup(redis, cacheKey, rollup);
        return rollup;
      } finally {
        await redis.eval(releaseLockScript, 1, lockKey, lockValue);
      }
    }

    const rollupAfterWait = await waitForCachedRollup(redis, cacheKey);

    if (rollupAfterWait !== null) {
      return rollupAfterWait;
    }
  }

  throw new Error("Timed out waiting for Case Queue rollup cache rebuild.");
}

async function readRollupFromDynamo(
  dynamo: CaseQueueDynamoQueryClient,
  authContext: Pick<AuthenticatedRequestContext, "tenantId">
): Promise<CaseQueueRollup> {
  const items = await queryTenantCases(dynamo, authContext);
  const countsByStage = new Map(
    expenseReportStages.map((stage) => [stage, { reportCount: 0, overdueCount: 0 }])
  );

  for (const item of items) {
    const counts = countsByStage.get(item.stage);

    if (counts === undefined) {
      continue;
    }

    counts.reportCount += 1;

    if (item.overdue) {
      counts.overdueCount += 1;
    }
  }

  return expenseReportStages.map((stage) => ({
    stage,
    reportCount: countsByStage.get(stage)?.reportCount ?? 0,
    overdueCount: countsByStage.get(stage)?.overdueCount ?? 0
  }));
}

async function waitForCachedRollup(
  redis: CaseQueueRollupRedisClient,
  cacheKey: string
): Promise<CaseQueueRollup | null> {
  for (let attempt = 0; attempt < lockRetryAttempts; attempt += 1) {
    await sleep(lockRetryDelayMs);
    const cachedRollup = await readCachedRollup(redis, cacheKey);

    if (cachedRollup !== null) {
      return cachedRollup;
    }
  }

  return null;
}

async function readCachedRollup(
  redis: Pick<CaseQueueRollupRedisClient, "get">,
  cacheKey: string
): Promise<CaseQueueRollup | null> {
  const cachedValue = await redis.get(cacheKey);

  if (cachedValue === null) {
    return null;
  }

  return JSON.parse(cachedValue) as CaseQueueRollup;
}

async function writeCachedRollup(
  redis: Pick<CaseQueueRollupRedisClient, "set">,
  cacheKey: string,
  rollup: CaseQueueRollup
): Promise<void> {
  await redis.set(cacheKey, JSON.stringify(rollup), "EX", caseQueueRollupCacheTtlSeconds);
}

function validateTenantId(tenantId: string): void {
  if (tenantId.trim().length === 0) {
    throw new Error("authContext.tenantId is required for Case Queue rollup cache.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
