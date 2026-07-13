import { RequestHandler } from "express";

import { requireAuthenticatedContext } from "../auth/verifier.js";
import { ExpenseWriteRateLimitConfig } from "../config/expense-write-rate-limit.js";

const expenseWriteTokenBucketScript = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local refill_rate = capacity / window_ms
local ttl_ms = math.ceil(window_ms * 2)

local bucket = redis.call("HMGET", key, "tokens", "updatedAt")
local tokens = tonumber(bucket[1])
local updated_at = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
end

if updated_at == nil then
  updated_at = now_ms
end

local elapsed_ms = math.max(0, now_ms - updated_at)
tokens = math.min(capacity, tokens + (elapsed_ms * refill_rate))

local allowed = 0
local retry_after_ms = 0

if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry_after_ms = math.ceil((1 - tokens) / refill_rate)
end

redis.call("HMSET", key, "tokens", tostring(tokens), "updatedAt", tostring(now_ms))
redis.call("PEXPIRE", key, ttl_ms)

return { allowed, retry_after_ms }
`;

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

interface ExpenseWriteTokenBucketOptions {
  nowMs?: () => number;
}

interface TokenBucketResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function createExpenseWriteTokenBucketRateLimiter(
  config: ExpenseWriteRateLimitConfig,
  redis: RedisEvalClient,
  options: ExpenseWriteTokenBucketOptions = {}
): RequestHandler {
  const nowMs = options.nowMs ?? Date.now;

  return async (request, response, next): Promise<void> => {
    try {
      const authContext = requireAuthenticatedContext(request);
      const bucketKey = createExpenseWriteTokenBucketKey(authContext.tenantId);
      const result = parseTokenBucketResult(
        await redis.eval(
          expenseWriteTokenBucketScript,
          1,
          bucketKey,
          String(config.expenseWriteRateLimitMax),
          String(config.expenseWriteRateLimitWindowMs),
          String(nowMs())
        )
      );

      if (result.allowed) {
        next();
        return;
      }

      response
        .setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)))
        .status(429)
        .json({ error: "Expense Report write rate limit exceeded." });
    } catch (error) {
      next(error);
    }
  };
}

export function createExpenseWriteTokenBucketKey(tenantId: string): string {
  return `expense-write:tenant:${tenantId}:token-bucket`;
}

function parseTokenBucketResult(value: unknown): TokenBucketResult {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error("Redis token bucket script returned an invalid result.");
  }

  const allowed = parseRedisNumber(value[0]);
  const retryAfterMs = parseRedisNumber(value[1]);

  if (allowed !== 0 && allowed !== 1) {
    throw new Error("Redis token bucket script returned an invalid allow flag.");
  }

  if (retryAfterMs < 0) {
    throw new Error("Redis token bucket script returned an invalid retry delay.");
  }

  return {
    allowed: allowed === 1,
    retryAfterMs
  };
}

function parseRedisNumber(value: unknown): number {
  const parsedValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isFinite(parsedValue)) {
    throw new Error("Redis token bucket script returned a non-numeric value.");
  }

  return parsedValue;
}
