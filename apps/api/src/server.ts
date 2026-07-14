import { createServer } from "node:http";

import { Redis } from "ioredis";

import { createApp } from "./app.js";
import { getApiRuntimeConfig } from "./config/runtime-config.js";
import {
  preloadRuntimeSecrets,
  startRuntimeSecretRefresh,
  stopRuntimeSecretRefresh
} from "./config/runtime-secrets.js";
import { closeDatabasePool } from "./db/client.js";
import { createExpenseWriteRateLimiters } from "./middleware/rate-limit.js";

let redisClient: Redis | undefined;
let server: ReturnType<typeof createServer> | undefined;
let shutdownStarted = false;

startServer().catch((error: unknown) => {
  console.error("ExpenseFlow API startup failed.", error);
  process.exit(1);
});

async function startServer(): Promise<void> {
  const config = getApiRuntimeConfig();

  await preloadRuntimeSecrets(config);
  startRuntimeSecretRefresh(config);

  redisClient = new Redis(config.REDIS_URL, {
    lazyConnect: true
  });

  try {
    await redisClient.connect();
    await redisClient.ping();
  } catch (error) {
    console.error("ExpenseFlow API Redis startup failed.", error);
    process.exit(1);
  }

  const app = createApp({
    expenseWriteRateLimiters: createExpenseWriteRateLimiters(
      {
        redisUrl: config.REDIS_URL,
        expenseWriteRateLimitWindowMs: config.EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS,
        expenseWriteRateLimitMax: config.EXPENSE_WRITE_RATE_LIMIT_MAX,
        expenseWriteSlowDownAfter: config.EXPENSE_WRITE_SLOW_DOWN_AFTER,
        expenseWriteDelayIncrementMs: config.EXPENSE_WRITE_DELAY_INCREMENT_MS,
        expenseWriteMaxDelayMs: config.EXPENSE_WRITE_MAX_DELAY_MS
      },
      redisClient
    )
  });
  server = createServer(app);

  server.listen(config.PORT, () => {
    console.log(`ExpenseFlow API listening on port ${config.PORT}.`);
  });
}

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.log(`Received ${signal}; shutting down ExpenseFlow API.`);

  if (server === undefined) {
    finishShutdown(undefined).catch((shutdownError: unknown) => {
      console.error("ExpenseFlow API shutdown failed.", shutdownError);
      process.exit(1);
    });
    return;
  }

  server.close((error) => {
    finishShutdown(error).catch((shutdownError: unknown) => {
      console.error("ExpenseFlow API shutdown failed.", shutdownError);
      process.exit(1);
    });
  });
}

async function finishShutdown(error: Error | undefined): Promise<void> {
  stopRuntimeSecretRefresh();

  try {
    await redisClient?.quit();
  } catch (redisError) {
    console.error("ExpenseFlow API Redis shutdown failed.", redisError);
    process.exit(1);
  }

  try {
    await closeDatabasePool();
  } catch (dbError) {
    console.error("ExpenseFlow API database shutdown failed.", dbError);
    process.exit(1);
  }

  if (error !== undefined) {
    console.error("ExpenseFlow API shutdown failed.", error);
    process.exit(1);
  }

  console.log("ExpenseFlow API shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
