import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";

import { requireAuthenticatedContext } from "../auth/verifier.js";
import { ConflictError } from "../errors/problem-json.js";

export const idempotencyReplayTtlSeconds = 24 * 60 * 60;
// Covers the expected worst-case Expense Report handler duration while abandoned locks expire.
export const idempotencyLockTtlMs = 30_000;

const idempotencyHeaderName = "Idempotency-Key";
const releaseLockScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

interface StoredIdempotencyReplay {
  status: number;
  body: unknown;
}

interface CapturedJsonResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "PX", ttlMs: number, condition: "NX"): Promise<"OK" | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export function createIdempotencyKeyMiddleware(redis: IdempotencyRedisClient): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const rawIdempotencyKey = request.get(idempotencyHeaderName);

    if (rawIdempotencyKey === undefined || rawIdempotencyKey.trim().length === 0) {
      next();
      return;
    }

    try {
      const authContext = requireAuthenticatedContext(request);
      const idempotencyKey = rawIdempotencyKey.trim();
      const replayKey = createIdempotencyReplayKey(authContext.tenantId, idempotencyKey);
      const replay = await readStoredReplay(redis, replayKey);

      if (replay !== null) {
        response.status(replay.status).json(replay.body);
        return;
      }

      const lockKey = createIdempotencyLockKey(authContext.tenantId, idempotencyKey);
      const lockValue = randomUUID();
      const lockAcquired = await redis.set(lockKey, lockValue, "PX", idempotencyLockTtlMs, "NX");

      if (lockAcquired !== "OK") {
        next(new ConflictError("A request with this Idempotency-Key is already in progress."));
        return;
      }

      const capturedResponse = captureJsonResponse(response);

      response.once("finish", () => {
        persistReplayAndReleaseLock(redis, replayKey, lockKey, lockValue, capturedResponse).catch(
          () => undefined
        );
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createIdempotencyReplayKey(tenantId: string, idempotencyKey: string): string {
  return `idem:${tenantId}:${idempotencyKey}`;
}

export function createIdempotencyLockKey(tenantId: string, idempotencyKey: string): string {
  return `lock:${tenantId}:${idempotencyKey}`;
}

function captureJsonResponse(response: Response): () => CapturedJsonResponse | null {
  const originalStatus = response.status.bind(response);
  const originalJson = response.json.bind(response);
  let explicitStatus: number | undefined;
  let capturedResponse: CapturedJsonResponse | null = null;

  response.status = ((statusCode: number) => {
    explicitStatus = statusCode;

    return originalStatus(statusCode);
  }) as Response["status"];

  response.json = ((body: unknown) => {
    capturedResponse = {
      status: explicitStatus ?? response.statusCode,
      body
    };

    return originalJson(body);
  }) as Response["json"];

  return () => capturedResponse;
}

async function readStoredReplay(
  redis: Pick<IdempotencyRedisClient, "get">,
  replayKey: string
): Promise<StoredIdempotencyReplay | null> {
  const storedValue = await redis.get(replayKey);

  if (storedValue === null) {
    return null;
  }

  return JSON.parse(storedValue) as StoredIdempotencyReplay;
}

async function persistReplayAndReleaseLock(
  redis: IdempotencyRedisClient,
  replayKey: string,
  lockKey: string,
  lockValue: string,
  readCapturedResponse: () => CapturedJsonResponse | null
): Promise<void> {
  try {
    const capturedResponse = readCapturedResponse();

    if (capturedResponse !== null && capturedResponse.status < 500) {
      await redis.set(
        replayKey,
        JSON.stringify(capturedResponse),
        "EX",
        idempotencyReplayTtlSeconds
      );
    }
  } finally {
    await redis.eval(releaseLockScript, 1, lockKey, lockValue);
  }
}
