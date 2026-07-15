import { afterEach, beforeEach, describe, expect, it } from "vitest";

import pg from "pg";
import request from "supertest";

import { createApp } from "../src/app.js";
import { issueTokenPair } from "../src/auth/tokens.js";
import {
  createIdempotencyKeyMiddleware,
  createIdempotencyLockKey,
  createIdempotencyReplayKey,
  type IdempotencyRedisClient
} from "../src/store/idempotency.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000701";
const tenantB = "00000000-0000-4000-8000-000000000702";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000703";
let client: pg.Client;

describe("Expense Report Idempotency-Key integration", () => {
  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("creates one Expense Report and replays identical responses for three retries with one key", async () => {
    const redis = new FakeRedis();
    const app = createIdempotentApp(redis);
    const idempotencyKey = "synthetic-three-retry-key";

    const firstResponse = await submitExpenseReport(app, tenantA, idempotencyKey);
    await waitForReplay(redis, tenantA, idempotencyKey);
    const secondResponse = await submitExpenseReport(app, tenantA, idempotencyKey);
    const thirdResponse = await submitExpenseReport(app, tenantA, idempotencyKey);

    expect([firstResponse.status, secondResponse.status, thirdResponse.status]).toEqual([
      201, 201, 201
    ]);
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(thirdResponse.body).toEqual(firstResponse.body);
    expect(firstResponse.body.id).toEqual(expect.any(String));
    await expect(countExpenseReports(tenantA)).resolves.toBe(1);
  });

  it("scopes Idempotency-Key replays by tenant claim", async () => {
    const redis = new FakeRedis();
    const app = createIdempotentApp(redis);
    const idempotencyKey = "synthetic-shared-tenant-key";

    const tenantAResponse = await submitExpenseReport(app, tenantA, idempotencyKey);
    const tenantBResponse = await submitExpenseReport(app, tenantB, idempotencyKey);
    await waitForReplay(redis, tenantA, idempotencyKey);
    await waitForReplay(redis, tenantB, idempotencyKey);

    expect(tenantAResponse.status).toBe(201);
    expect(tenantBResponse.status).toBe(201);
    expect(tenantAResponse.body.id).not.toBe(tenantBResponse.body.id);
    await expect(countExpenseReports(tenantA)).resolves.toBe(1);
    await expect(countExpenseReports(tenantB)).resolves.toBe(1);
  });

  it("blocks one concurrent retry with 409 and never creates a duplicate", async () => {
    const redis = new FakeRedis();
    const app = createIdempotentApp(redis);
    const idempotencyKey = "synthetic-concurrent-key";

    const [firstResponse, secondResponse] = await Promise.all([
      submitExpenseReport(app, tenantA, idempotencyKey),
      submitExpenseReport(app, tenantA, idempotencyKey)
    ]);
    const responses = [firstResponse, secondResponse];
    const createdResponse = responses.find((response) => response.status === 201);
    const conflictResponse = responses.find((response) => response.status === 409);

    expect(createdResponse?.body.id).toEqual(expect.any(String));
    expect(conflictResponse?.body).toMatchObject({
      type: "/problems/conflict",
      title: "Conflict",
      status: 409
    });
    await expect(countExpenseReports(tenantA)).resolves.toBe(1);

    await waitForReplay(redis, tenantA, idempotencyKey);
    const replayResponse = await submitExpenseReport(app, tenantA, idempotencyKey);

    expect(replayResponse.status).toBe(201);
    expect(replayResponse.body).toEqual(createdResponse?.body);
    await expect(countExpenseReports(tenantA)).resolves.toBe(1);
  });
});

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

class FakeRedis implements IdempotencyRedisClient {
  private readonly entries = new Map<string, RedisEntry>();
  private nowMs = 0;

  public async get(key: string): Promise<string | null> {
    return this.readUnexpiredEntry(key)?.value ?? null;
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

    this.entries.set(key, {
      value,
      expiresAtMs: this.nowMs + (mode === "EX" ? ttl * 1_000 : ttl)
    });

    return "OK";
  }

  public async eval(
    _script: string,
    _numberOfKeys: number,
    key: string,
    lockValue: string
  ): Promise<number> {
    if ((await this.get(key)) !== lockValue) {
      return 0;
    }

    return this.entries.delete(key) ? 1 : 0;
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

function createIdempotentApp(redis: IdempotencyRedisClient): ReturnType<typeof createApp> {
  return createApp({
    expenseReportIdempotencyMiddleware: createIdempotencyKeyMiddleware(redis)
  });
}

function submitExpenseReport(
  app: ReturnType<typeof createApp>,
  tenantId: string,
  idempotencyKey: string
) {
  return request(app)
    .post("/v1/expense-reports")
    .set("Authorization", createBearerToken(tenantId))
    .set("Idempotency-Key", idempotencyKey)
    .send({});
}

function createBearerToken(tenantId: string): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles: ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}

async function countExpenseReports(tenantId: string): Promise<number> {
  const result = await client.query<{ report_count: string }>(
    `
    select count(*)::text as report_count
    from expense_report
    where tenant_id = $1;
    `,
    [tenantId]
  );

  return Number.parseInt(result.rows[0]?.report_count ?? "0", 10);
}

async function waitForReplay(
  redis: FakeRedis,
  tenantId: string,
  idempotencyKey: string
): Promise<void> {
  await waitUntil(
    async () => (await redis.get(createIdempotencyReplayKey(tenantId, idempotencyKey))) !== null
  );
  await waitUntil(
    async () => (await redis.get(createIdempotencyLockKey(tenantId, idempotencyKey))) === null
  );
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }

  throw new Error("Timed out waiting for idempotency side effect.");
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for Idempotency-Key integration tests.");
  }

  return process.env.DATABASE_URI;
}
