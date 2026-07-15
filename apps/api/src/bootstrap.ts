import { createServer } from "node:http";

import type express from "express";
import { Redis } from "ioredis";

import { createApp } from "./app.js";
import { getApiRuntimeConfig, type ApiRuntimeConfig } from "./config/runtime-config.js";
import {
  preloadRuntimeSecrets,
  startRuntimeSecretRefresh,
  stopRuntimeSecretRefresh
} from "./config/runtime-secrets.js";
import { assertDatabaseReady, closeDatabasePool } from "./db/client.js";
import { createExpenseWriteRateLimiters } from "./middleware/rate-limit.js";
import {
  createIdempotencyKeyMiddleware,
  type IdempotencyRedisClient
} from "./store/idempotency.js";

type HttpServer = ReturnType<typeof createServer>;

export interface ApiServerHandle {
  server: HttpServer;
  redisClient: RedisLike;
  shutdown(): Promise<void>;
}

export interface RedisLike {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface StartApiServerDependencies {
  getConfig?: () => ApiRuntimeConfig;
  preloadSecrets?: (config: ApiRuntimeConfig) => Promise<unknown>;
  startSecretRefresh?: (config: ApiRuntimeConfig) => void;
  stopSecretRefresh?: () => void;
  createRedisClient?: (redisUrl: string) => RedisLike;
  assertDbReady?: () => Promise<void>;
  closeDbPool?: () => Promise<void>;
  buildApp?: (config: ApiRuntimeConfig, redisClient: RedisLike) => express.Express;
  createHttpServer?: (app: express.Express) => HttpServer;
}

export async function startApiServer(
  dependencies: StartApiServerDependencies = {}
): Promise<ApiServerHandle> {
  const getConfig = dependencies.getConfig ?? getApiRuntimeConfig;
  const preloadSecrets = dependencies.preloadSecrets ?? preloadRuntimeSecrets;
  const startSecretRefresh = dependencies.startSecretRefresh ?? startRuntimeSecretRefresh;
  const stopSecretRefresh = dependencies.stopSecretRefresh ?? stopRuntimeSecretRefresh;
  const createRedisClient = dependencies.createRedisClient ?? createDefaultRedisClient;
  const assertDbReady = dependencies.assertDbReady ?? assertDatabaseReady;
  const closeDbPool = dependencies.closeDbPool ?? closeDatabasePool;
  const buildApp = dependencies.buildApp ?? createDefaultApp;
  const createHttpServer = dependencies.createHttpServer ?? createServer;
  const config = getConfig();
  let redisClient: RedisLike | undefined;
  let secretRefreshStarted = false;

  try {
    await preloadSecrets(config);
    startSecretRefresh(config);
    secretRefreshStarted = true;

    redisClient = createRedisClient(config.REDIS_URL);
    await redisClient.connect();
    await redisClient.ping();
    await assertDbReady();

    const readyRedisClient = redisClient;
    const server = createHttpServer(buildApp(config, redisClient));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.PORT, () => {
        server.off("error", reject);
        resolve();
      });
    });

    return {
      server,
      redisClient: readyRedisClient,
      async shutdown() {
        await shutdownApiServer({
          server,
          redisClient: readyRedisClient,
          stopSecretRefresh,
          closeDbPool
        });
      }
    };
  } catch (error) {
    if (secretRefreshStarted) {
      stopSecretRefresh();
    }

    if (redisClient !== undefined) {
      await redisClient.quit().catch(() => undefined);
    }

    await closeDbPool().catch(() => undefined);
    throw error;
  }
}

async function shutdownApiServer({
  server,
  redisClient,
  stopSecretRefresh,
  closeDbPool
}: {
  server: HttpServer;
  redisClient: RedisLike;
  stopSecretRefresh: () => void;
  closeDbPool: () => Promise<void>;
}): Promise<void> {
  stopSecretRefresh();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
  await redisClient.quit();
  await closeDbPool();
}

function createDefaultRedisClient(redisUrl: string): RedisLike {
  return new Redis(redisUrl, {
    lazyConnect: true
  });
}

function createDefaultApp(config: ApiRuntimeConfig, redisClient: RedisLike): express.Express {
  return createApp({
    expenseWriteRateLimiters: createExpenseWriteRateLimiters(
      {
        redisUrl: config.REDIS_URL,
        expenseWriteRateLimitWindowMs: config.EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS,
        expenseWriteRateLimitMax: config.EXPENSE_WRITE_RATE_LIMIT_MAX,
        expenseWriteSlowDownAfter: config.EXPENSE_WRITE_SLOW_DOWN_AFTER,
        expenseWriteDelayIncrementMs: config.EXPENSE_WRITE_DELAY_INCREMENT_MS,
        expenseWriteMaxDelayMs: config.EXPENSE_WRITE_MAX_DELAY_MS
      },
      redisClient as Redis
    ),
    expenseReportIdempotencyMiddleware: createIdempotencyKeyMiddleware(
      redisClient as unknown as IdempotencyRedisClient
    )
  });
}
