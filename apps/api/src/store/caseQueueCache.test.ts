import {
  QueryCommand,
  type AttributeValue,
  type QueryCommandOutput
} from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";

import type { AuthenticatedRequestContext } from "../auth/verifier.js";
import type { ExpenseReportStage } from "../repository/case-queue.js";
import {
  caseQueueRollupCacheTtlSeconds,
  createCaseQueueRollupCacheKey,
  createCaseQueueRollupLockKey,
  invalidateCaseQueueRollupCache,
  readCaseQueueRollupWithCache,
  type CaseQueueRollupRedisClient
} from "./caseQueueCache.js";
import type { CaseQueueDynamoQueryClient, CaseQueueReadModelItem } from "./dynamo.js";

const tenantA = "00000000-0000-4000-8000-000000000501";
const tenantB = "00000000-0000-4000-8000-000000000502";

describe("readCaseQueueRollupWithCache", () => {
  it("returns a second read from Redis without another DynamoDB query", async () => {
    const redis = new FakeRedis();
    const dynamo = new FakeDynamo([
      makeItem("case-1", tenantA, "Drafted", true),
      makeItem("case-2", tenantA, "Drafted", false),
      makeItem("case-3", tenantA, "Submitted", false),
      makeItem("case-other-tenant", tenantB, "Paid", true)
    ]);

    const firstRead = await readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA));
    const secondRead = await readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA));

    expect(firstRead).toEqual(secondRead);
    expect(stageSummary(secondRead, "Drafted")).toEqual({
      stage: "Drafted",
      reportCount: 2,
      overdueCount: 1
    });
    expect(stageSummary(secondRead, "Submitted")).toEqual({
      stage: "Submitted",
      reportCount: 1,
      overdueCount: 0
    });
    expect(dynamo.queryCount).toBe(1);
    expect(redis.setCalls).toContainEqual({
      key: createCaseQueueRollupCacheKey(tenantA),
      mode: "EX",
      ttl: caseQueueRollupCacheTtlSeconds
    });
  });

  it("invalidates the cached tenant rollup after a stage change", async () => {
    const redis = new FakeRedis();
    const dynamo = new FakeDynamo([makeItem("case-stage-change", tenantA, "Drafted", false)]);

    await readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA));

    dynamo.items = [makeItem("case-stage-change", tenantA, "Manager Approval", false)];
    await invalidateCaseQueueRollupCache(redis, authContextFor(tenantA));

    const rollupAfterInvalidation = await readCaseQueueRollupWithCache(
      redis,
      dynamo,
      authContextFor(tenantA)
    );

    expect(stageSummary(rollupAfterInvalidation, "Drafted")?.reportCount).toBe(0);
    expect(stageSummary(rollupAfterInvalidation, "Manager Approval")).toEqual({
      stage: "Manager Approval",
      reportCount: 1,
      overdueCount: 0
    });
    expect(dynamo.queryCount).toBe(2);
  });

  it("uses one DynamoDB rebuild for concurrent reads against an expired hot key", async () => {
    const redis = new FakeRedis();
    const dynamo = new FakeDynamo([makeItem("case-hot-key", tenantA, "AP Review", true)], 50);

    await redis.set(createCaseQueueRollupCacheKey(tenantA), JSON.stringify([]), "EX", 1);
    redis.advanceTime(1_001);

    const reads = await Promise.all([
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA)),
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA)),
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA)),
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA)),
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA))
    ]);

    expect(reads.every((rollup) => stageSummary(rollup, "AP Review")?.reportCount === 1)).toBe(
      true
    );
    expect(dynamo.queryCount).toBe(1);
  });

  it("fails deterministically when a competing rebuild never populates the cache", async () => {
    const redis = new FakeRedis();
    const dynamo = new FakeDynamo([makeItem("case-timeout", tenantA, "AP Review", true)]);

    await redis.set(createCaseQueueRollupLockKey(tenantA), "held", "PX", 60_000, "NX");

    await expect(
      readCaseQueueRollupWithCache(redis, dynamo, authContextFor(tenantA))
    ).rejects.toThrow("Timed out waiting for Case Queue rollup cache rebuild.");
    expect(dynamo.queryCount).toBe(0);
  });
});

class FakeDynamo implements CaseQueueDynamoQueryClient {
  public queryCount = 0;

  public constructor(
    public items: CaseQueueReadModelItem[],
    private readonly delayMs = 0
  ) {}

  public async send(command: QueryCommand): Promise<QueryCommandOutput> {
    this.queryCount += 1;

    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    const tenantKey = command.input.ExpressionAttributeValues?.[":pk"]?.S;
    const tenantId = tenantKey?.replace("TENANT#", "");

    return {
      $metadata: {},
      Items: this.items
        .filter((item) => item.tenantId === tenantId)
        .map((item) => toDynamoItem(item))
    };
  }
}

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

interface RedisSetCall {
  key: string;
  mode: "EX" | "PX";
  ttl: number;
}

class FakeRedis implements CaseQueueRollupRedisClient {
  public readonly setCalls: RedisSetCall[] = [];
  private readonly entries = new Map<string, RedisEntry>();
  private nowMs = 0;

  public async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAtMs <= this.nowMs) {
      this.entries.delete(key);
      return null;
    }

    return entry.value;
  }

  public set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  public set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX"
  ): Promise<"OK" | null>;
  public async set(
    key: string,
    value: string,
    mode: "EX" | "PX",
    ttl: number,
    condition?: "NX"
  ): Promise<"OK" | null> {
    if (condition === "NX" && this.readUnexpiredEntry(key) !== null) {
      return null;
    }

    this.setCalls.push({ key, mode, ttl });
    this.entries.set(key, {
      value,
      expiresAtMs: this.nowMs + (mode === "EX" ? ttl * 1_000 : ttl)
    });

    return "OK";
  }

  public async del(key: string): Promise<number> {
    return this.entries.delete(key) ? 1 : 0;
  }

  public async eval(
    _script: string,
    _numberOfKeys: number,
    key: string,
    lockValue: string
  ): Promise<number> {
    const currentValue = await this.get(key);

    if (currentValue !== lockValue) {
      return 0;
    }

    return this.del(key);
  }

  public advanceTime(ms: number): void {
    this.nowMs += ms;
  }

  private readUnexpiredEntry(key: string): RedisEntry | null {
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return null;
    }

    if (entry.expiresAtMs <= this.nowMs) {
      this.entries.delete(key);
      return null;
    }

    return entry;
  }
}

function authContextFor(tenantId: string): AuthenticatedRequestContext {
  return {
    tenantId,
    userId: "00000000-0000-4000-8000-000000000503",
    roles: ["Finance Admin"]
  };
}

function makeItem(
  caseId: string,
  tenantId: string,
  stage: ExpenseReportStage,
  overdue: boolean
): CaseQueueReadModelItem {
  return {
    caseId,
    tenantId,
    stage,
    dueDate: overdue ? "2026-07-14" : "2026-07-16",
    overdue
  };
}

function toDynamoItem(item: CaseQueueReadModelItem): Record<string, AttributeValue> {
  return {
    caseId: { S: item.caseId },
    tenantId: { S: item.tenantId },
    stage: { S: item.stage },
    dueDate: { S: item.dueDate },
    overdue: { BOOL: item.overdue }
  };
}

function stageSummary(
  rollup: Awaited<ReturnType<typeof readCaseQueueRollupWithCache>>,
  stage: ExpenseReportStage
) {
  return rollup.find((summary) => summary.stage === stage);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
