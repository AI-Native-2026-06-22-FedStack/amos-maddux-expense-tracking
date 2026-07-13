import { RequestHandler } from "express";
import { slowDown } from "express-slow-down";
import { RedisReply, RedisStore } from "rate-limit-redis";

import { requireAuthenticatedContext } from "../auth/verifier.js";
import { ExpenseWriteRateLimitConfig } from "../config/expense-write-rate-limit.js";
import { TooManyRequestsError } from "../errors/problem-json.js";

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

return { allowed, retry_after_ms, math.max(0, math.floor(tokens)) }
`;

const expenseWriteRateLimitIdentifier = "expense-write";
const expenseWriteSlowDownRedisPrefix = "expense-write:slow-down:";

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface RedisRateLimitClient extends RedisEvalClient {
  call(...args: string[]): Promise<unknown>;
}

interface ExpenseWriteTokenBucketOptions {
  nowMs?: () => number;
}

interface TokenBucketResult {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
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

      setExpenseWriteRateLimitHeaders(response, config, result);

      if (result.allowed) {
        next();
        return;
      }

      response.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      next(new TooManyRequestsError("Expense Report write rate limit exceeded."));
    } catch (error) {
      next(error);
    }
  };
}

export function createExpenseWriteRateLimiters(
  config: ExpenseWriteRateLimitConfig,
  redis: RedisRateLimitClient
): readonly RequestHandler[] {
  return [
    createExpenseWriteSlowDownRateLimiter(config, redis),
    createExpenseWriteTokenBucketRateLimiter(config, redis)
  ];
}

export function createExpenseWriteSlowDownRateLimiter(
  config: ExpenseWriteRateLimitConfig,
  redis: RedisRateLimitClient
): RequestHandler {
  const store = createExpressSlowDownRedisStore(config, redis);

  return slowDown({
    windowMs: config.expenseWriteRateLimitWindowMs,
    delayAfter: config.expenseWriteSlowDownAfter,
    delayMs: (used): number =>
      Math.min(
        Math.max(0, used - config.expenseWriteSlowDownAfter) *
          config.expenseWriteDelayIncrementMs,
        config.expenseWriteMaxDelayMs
      ),
    maxDelayMs: config.expenseWriteMaxDelayMs,
    keyGenerator: (request): string => requireAuthenticatedContext(request).tenantId,
    store,
    validate: {
      delayMs: false
    }
  });
}

export function createExpenseWriteTokenBucketKey(tenantId: string): string {
  return `expense-write:tenant:${tenantId}:token-bucket`;
}

export function createExpenseWriteSlowDownKey(tenantId: string): string {
  return `${expenseWriteSlowDownRedisPrefix}${tenantId}`;
}

function parseTokenBucketResult(value: unknown): TokenBucketResult {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error("Redis token bucket script returned an invalid result.");
  }

  const allowed = parseRedisNumber(value[0]);
  const retryAfterMs = parseRedisNumber(value[1]);
  const remaining = parseRedisNumber(value[2]);

  if (allowed !== 0 && allowed !== 1) {
    throw new Error("Redis token bucket script returned an invalid allow flag.");
  }

  if (retryAfterMs < 0 || remaining < 0) {
    throw new Error("Redis token bucket script returned an invalid retry delay.");
  }

  return {
    allowed: allowed === 1,
    retryAfterMs,
    remaining
  };
}

function setExpenseWriteRateLimitHeaders(
  response: Parameters<RequestHandler>[1],
  config: ExpenseWriteRateLimitConfig,
  result: TokenBucketResult
): void {
  const resetSeconds = Math.ceil(
    (result.allowed ? config.expenseWriteRateLimitWindowMs : result.retryAfterMs) / 1000
  );
  const windowSeconds = Math.ceil(config.expenseWriteRateLimitWindowMs / 1000);

  response.setHeader(
    "RateLimit",
    `"${expenseWriteRateLimitIdentifier}";r=${result.remaining};t=${resetSeconds}`
  );
  response.setHeader(
    "RateLimit-Policy",
    `"${expenseWriteRateLimitIdentifier}";q=${config.expenseWriteRateLimitMax};w=${windowSeconds}`
  );
  response.removeHeader("X-RateLimit-Limit");
  response.removeHeader("X-RateLimit-Remaining");
  response.removeHeader("X-RateLimit-Reset");
}

function parseRedisNumber(value: unknown): number {
  const parsedValue =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isFinite(parsedValue)) {
    throw new Error("Redis token bucket script returned a non-numeric value.");
  }

  return parsedValue;
}

function createExpressSlowDownRedisStore(
  config: ExpenseWriteRateLimitConfig,
  redis: RedisRateLimitClient
) {
  const redisStore = new RedisStore({
    prefix: expenseWriteSlowDownRedisPrefix,
    sendCommand: async (...args: string[]) => toRedisReply(await redis.call(...args))
  });

  redisStore.windowMs = config.expenseWriteRateLimitWindowMs;
  redisStore.incrementScriptSha = redisStore.loadIncrementScript();
  redisStore.getScriptSha = redisStore.loadGetScript();

  return {
    incr(
      key: string,
      callback: (error: Error | undefined, totalHits: number, resetTime: Date | undefined) => void
    ): void {
      void redisStore.increment(key).then(
        ({ totalHits, resetTime }) => {
          callback(undefined, totalHits, resetTime);
        },
        (error: unknown) => {
          callback(toError(error), 0, undefined);
        }
      );
    },
    decrement(key: string): void {
      void redisStore.decrement(key);
    },
    resetKey(key: string): void {
      void redisStore.resetKey(key);
    }
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Redis slow-down store failed.");
}

function toRedisReply(value: unknown): RedisReply {
  if (isRedisReply(value)) {
    return value;
  }

  throw new Error("Redis slow-down store returned an unsupported reply.");
}

function isRedisReply(value: unknown): value is RedisReply {
  if (isRedisData(value)) {
    return true;
  }

  return Array.isArray(value) && value.every(isRedisData);
}

function isRedisData(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}
