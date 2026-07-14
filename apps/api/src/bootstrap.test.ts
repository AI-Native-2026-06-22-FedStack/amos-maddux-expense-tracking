import { EventEmitter } from "node:events";

import express from "express";
import { describe, expect, it, vi } from "vitest";

import { startApiServer, type RedisLike } from "./bootstrap.js";
import { loadApiRuntimeConfig } from "./config/runtime-config.js";

const validEnvironment = {
  NODE_ENV: "production",
  AWS_ENDPOINT: "http://localhost:4566",
  AWS_REGION: "us-east-1",
  DB_PASSWORD_SECRET_ID: "expenseflow/local/db-password",
  JWT_SIGNING_KEYS_SECRET_ID: "expenseflow/local/jwt-signing-keys",
  DATABASE_URI: "postgres://expenseflow@localhost:5432/expenseflow",
  REDIS_URL: "redis://localhost:6379",
  PORT: "3000",
  EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: "60000",
  EXPENSE_WRITE_RATE_LIMIT_MAX: "120",
  EXPENSE_WRITE_SLOW_DOWN_AFTER: "80",
  EXPENSE_WRITE_DELAY_INCREMENT_MS: "250",
  EXPENSE_WRITE_MAX_DELAY_MS: "5000"
};
const validConfig = loadApiRuntimeConfig(validEnvironment);

describe("startApiServer", () => {
  it("does not listen when strict runtime config is invalid", async () => {
    const server = createFakeHttpServer();

    await expect(
      startApiServer({
        getConfig() {
          return loadApiRuntimeConfig({
            ...validEnvironment,
            AWS_ENDPOINT: "not-a-url"
          });
        },
        createHttpServer: () => server
      })
    ).rejects.toThrow();

    expect(server.listen).not.toHaveBeenCalled();
  });

  it("does not listen when startup secret preload fails", async () => {
    const server = createFakeHttpServer();
    const redisClient = createFakeRedisClient();

    await expect(
      startApiServer({
        getConfig: () => validConfig,
        preloadSecrets: async () => {
          throw new Error("Synthetic missing LocalStack secret.");
        },
        createRedisClient: () => redisClient,
        createHttpServer: () => server
      })
    ).rejects.toThrow("Synthetic missing LocalStack secret.");

    expect(server.listen).not.toHaveBeenCalled();
    expect(redisClient.connect).not.toHaveBeenCalled();
  });

  it("does not listen and cleans up when the startup DB check fails", async () => {
    const server = createFakeHttpServer();
    const redisClient = createFakeRedisClient();
    const stopSecretRefresh = vi.fn();
    const closeDbPool = vi.fn().mockResolvedValue(undefined);

    await expect(
      startApiServer({
        getConfig: () => validConfig,
        preloadSecrets: vi.fn().mockResolvedValue(undefined),
        startSecretRefresh: vi.fn(),
        stopSecretRefresh,
        createRedisClient: () => redisClient,
        assertDbReady: async () => {
          throw new Error("Synthetic DB startup failure.");
        },
        closeDbPool,
        buildApp: () => express(),
        createHttpServer: () => server
      })
    ).rejects.toThrow("Synthetic DB startup failure.");

    expect(server.listen).not.toHaveBeenCalled();
    expect(redisClient.connect).toHaveBeenCalledOnce();
    expect(redisClient.ping).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
    expect(stopSecretRefresh).toHaveBeenCalledOnce();
    expect(closeDbPool).toHaveBeenCalledOnce();
  });

  it("listens only after secrets, Redis, and DB are ready", async () => {
    const server = createFakeHttpServer();
    const redisClient = createFakeRedisClient();

    const handle = await startApiServer({
      getConfig: () => validConfig,
      preloadSecrets: vi.fn().mockResolvedValue(undefined),
      startSecretRefresh: vi.fn(),
      stopSecretRefresh: vi.fn(),
      createRedisClient: () => redisClient,
      assertDbReady: vi.fn().mockResolvedValue(undefined),
      closeDbPool: vi.fn().mockResolvedValue(undefined),
      buildApp: () => express(),
      createHttpServer: () => server
    });

    expect(server.listen).toHaveBeenCalledOnce();

    await handle.shutdown();

    expect(server.close).toHaveBeenCalledOnce();
    expect(redisClient.quit).toHaveBeenCalledOnce();
  });
});

function createFakeRedisClient(): RedisLike {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue(undefined)
  };
}

function createFakeHttpServer() {
  const emitter = new EventEmitter();

  return {
    listen: vi.fn((_port: number, callback: () => void) => {
      callback();
      return emitter;
    }),
    close: vi.fn((callback: (error?: Error) => void) => {
      callback();
    }),
    once: vi.fn((eventName: string, listener: (...arguments_: unknown[]) => void) => {
      emitter.once(eventName, listener);
      return emitter;
    }),
    off: vi.fn((eventName: string, listener: (...arguments_: unknown[]) => void) => {
      emitter.off(eventName, listener);
      return emitter;
    }),
    address: vi.fn(() => ({ port: validConfig.PORT }))
  } as unknown as ReturnType<typeof import("node:http").createServer>;
}
