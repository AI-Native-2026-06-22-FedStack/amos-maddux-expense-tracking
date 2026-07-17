import express, { type RequestHandler } from "express";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { problemJsonErrorHandler } from "../errors/problem-json.js";
import {
  createIdempotencyKeyMiddleware,
  createIdempotencyLockKey,
  createIdempotencyReplayKey,
  idempotencyLockTtlMs,
  idempotencyReplayTtlSeconds,
  type IdempotencyRedisClient
} from "./idempotency.js";

const tenantA = "00000000-0000-4000-8000-000000000601";
const tenantB = "00000000-0000-4000-8000-000000000602";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000603";
const idempotencyKey = "synthetic-idempotency-key";

describe("createIdempotencyKeyMiddleware", () => {
  it("replays a seen key without calling the downstream handler", async () => {
    const redis = new FakeRedis();
    const replayBody = { id: "synthetic-replayed-report", currentStage: "Drafted" };
    await redis.set(
      createIdempotencyReplayKey(tenantA, idempotencyKey),
      JSON.stringify({ status: 201, body: replayBody }),
      "EX",
      idempotencyReplayTtlSeconds
    );
    let handlerCalled = false;
    const app = createSyntheticApp(redis, tenantA, (_request, response) => {
      handlerCalled = true;
      response.status(201).json({ id: "synthetic-new-report" });
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(replayBody);
    expect(handlerCalled).toBe(false);
  });

  it("stores a fresh non-5xx JSON response with a 24 hour TTL and releases the lock", async () => {
    const redis = new FakeRedis();
    const responseBody = { id: "synthetic-created-report", currentStage: "Drafted" };
    const app = createSyntheticApp(redis, tenantA, (_request, response) => {
      response.status(201).json(responseBody);
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });
    await waitForReplay(redis, tenantA, idempotencyKey);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(responseBody);
    expect(redis.setCalls).toContainEqual({
      key: createIdempotencyLockKey(tenantA, idempotencyKey),
      mode: "PX",
      ttl: idempotencyLockTtlMs,
      condition: "NX"
    });
    expect(redis.setCalls).toContainEqual({
      key: createIdempotencyReplayKey(tenantA, idempotencyKey),
      mode: "EX",
      ttl: idempotencyReplayTtlSeconds,
      condition: undefined
    });
    expect(redis.evalCalls).toHaveLength(1);
    expect(await redis.get(createIdempotencyLockKey(tenantA, idempotencyKey))).toBeNull();
  });

  it("does not store transient 5xx responses but still releases the lock", async () => {
    const redis = new FakeRedis();
    const app = createSyntheticApp(redis, tenantA, (_request, response) => {
      response.status(503).json({ error: "Synthetic transient failure." });
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });
    await waitForLockRelease(redis, tenantA, idempotencyKey);

    expect(response.statusCode).toBe(503);
    expect(await redis.get(createIdempotencyReplayKey(tenantA, idempotencyKey))).toBeNull();
    expect(await redis.get(createIdempotencyLockKey(tenantA, idempotencyKey))).toBeNull();
  });

  it("returns 409 when the per-tenant key lock is already held", async () => {
    const redis = new FakeRedis();
    await redis.set(
      createIdempotencyLockKey(tenantA, idempotencyKey),
      "locked",
      "PX",
      30_000,
      "NX"
    );
    let handlerCalled = false;
    const app = createSyntheticApp(redis, tenantA, (_request, response) => {
      handlerCalled = true;
      response.status(201).json({});
    });

    const response = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: "/problems/conflict",
      title: "Conflict",
      status: 409
    });
    expect(handlerCalled).toBe(false);
  });

  it("scopes replay keys by tenant from the auth context", async () => {
    const redis = new FakeRedis();
    const tenantAApp = createSyntheticApp(redis, tenantA, (_request, response) => {
      response.status(201).json({ tenant: "A" });
    });
    const tenantBApp = createSyntheticApp(redis, tenantB, (_request, response) => {
      response.status(201).json({ tenant: "B" });
    });

    await inject(tenantAApp, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });
    await inject(tenantBApp, {
      method: "POST",
      url: "/expense-reports",
      headers: { "idempotency-key": idempotencyKey },
      payload: {}
    });
    await waitForReplay(redis, tenantA, idempotencyKey);
    await waitForReplay(redis, tenantB, idempotencyKey);

    expect(await redis.get(createIdempotencyReplayKey(tenantA, idempotencyKey))).not.toBeNull();
    expect(await redis.get(createIdempotencyReplayKey(tenantB, idempotencyKey))).not.toBeNull();
    expect(createIdempotencyReplayKey(tenantA, idempotencyKey)).not.toBe(
      createIdempotencyReplayKey(tenantB, idempotencyKey)
    );
  });

  it("passes through requests without an Idempotency-Key", async () => {
    const redis = new FakeRedis();
    let handlerCallCount = 0;
    const app = createSyntheticApp(redis, tenantA, (_request, response) => {
      handlerCallCount += 1;
      response.status(201).json({ call: handlerCallCount });
    });

    const firstResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      payload: {}
    });
    const secondResponse = await inject(app, {
      method: "POST",
      url: "/expense-reports",
      payload: {}
    });

    expect(firstResponse.json()).toEqual({ call: 1 });
    expect(secondResponse.json()).toEqual({ call: 2 });
    expect(redis.setCalls).toEqual([]);
  });
});

interface RedisEntry {
  value: string;
  expiresAtMs: number;
}

interface RedisSetCall {
  key: string;
  mode: "EX" | "PX";
  ttl: number;
  condition?: "NX";
}

class FakeRedis implements IdempotencyRedisClient {
  public readonly setCalls: RedisSetCall[] = [];
  public readonly evalCalls: string[][] = [];
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

    this.setCalls.push({ key, mode, ttl, condition });
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
    this.evalCalls.push([key, lockValue]);

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

function createSyntheticApp(
  redis: IdempotencyRedisClient,
  tenantId: string,
  handler: RequestHandler
): express.Express {
  const app = express();

  app.use(express.json());
  app.use(bindSyntheticAuthContext(tenantId));
  app.post("/expense-reports", createIdempotencyKeyMiddleware(redis), handler);
  app.use(problemJsonErrorHandler);

  return app;
}

function bindSyntheticAuthContext(tenantId: string): RequestHandler {
  return (request, _response, next) => {
    request.authContext = {
      tenantId,
      userId,
      roles: ["Employee"]
    };
    next();
  };
}

async function waitForReplay(redis: FakeRedis, tenantId: string, key: string): Promise<void> {
  await waitUntil(
    async () => (await redis.get(createIdempotencyReplayKey(tenantId, key))) !== null
  );
}

async function waitForLockRelease(redis: FakeRedis, tenantId: string, key: string): Promise<void> {
  await waitUntil(async () => (await redis.get(createIdempotencyLockKey(tenantId, key))) === null);
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }

  throw new Error("Timed out waiting for idempotency middleware side effect.");
}
