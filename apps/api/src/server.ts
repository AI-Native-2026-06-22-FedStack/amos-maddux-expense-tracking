import { createServer } from "node:http";

import { Redis } from "ioredis";

import { createApp } from "./app.js";
import { loadExpenseWriteRateLimitConfig } from "./config/expense-write-rate-limit.js";
import { createExpenseWriteRateLimiters } from "./middleware/rate-limit.js";

const defaultPort = 3000;
const port = readPort(process.env.PORT);
const expenseWriteRateLimitConfig = loadExpenseWriteRateLimitConfig();
const redisClient = new Redis(expenseWriteRateLimitConfig.redisUrl, {
  lazyConnect: true
});
const app = createApp({
  expenseWriteRateLimiters: createExpenseWriteRateLimiters(
    expenseWriteRateLimitConfig,
    redisClient
  )
});
const server = createServer(app);
let shutdownStarted = false;

void startServer();

async function startServer(): Promise<void> {
  try {
    await redisClient.connect();
    await redisClient.ping();
  } catch (error) {
    console.error("ExpenseFlow API Redis startup failed.", error);
    process.exit(1);
  }

  server.listen(port, () => {
    console.log(`ExpenseFlow API listening on port ${port}.`);
  });
}

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.log(`Received ${signal}; shutting down ExpenseFlow API.`);

  server.close((error) => {
    void finishShutdown(error);
  });
}

async function finishShutdown(error: Error | undefined): Promise<void> {
  try {
    await redisClient.quit();
  } catch (redisError) {
    console.error("ExpenseFlow API Redis shutdown failed.", redisError);
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

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return defaultPort;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0 || parsedValue > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
  }

  return parsedValue;
}
