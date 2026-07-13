import { createServer } from "node:http";

import { Redis } from "ioredis";

import { createApp } from "./app.js";
import { loadExpenseWriteRateLimitConfig } from "./config/expense-write-rate-limit.js";
import { createExpenseWriteRateLimiters } from "./middleware/rate-limit.js";

const defaultPort = 3000;
const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
const expenseWriteRateLimitConfig = loadExpenseWriteRateLimitConfig();
const redisClient = new Redis(expenseWriteRateLimitConfig.redisUrl);
const app = createApp({
  expenseWriteRateLimiters: createExpenseWriteRateLimiters(
    expenseWriteRateLimitConfig,
    redisClient
  )
});
const server = createServer(app);

server.listen(port, () => {
  console.log(`ExpenseFlow API listening on port ${port}.`);
});

function shutdown(signal: NodeJS.Signals): void {
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
