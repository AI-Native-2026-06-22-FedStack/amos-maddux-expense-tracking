import { z } from "zod";

const maxDelayMsBound = 60_000;
const defaultPort = 3000;
const defaultJwtAccessTokenTtlSeconds = 15 * 60;
const defaultJwtRefreshTokenTtlSeconds = 30 * 24 * 60 * 60;

const runtimeConfigSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number().int().min(1).max(65_535).default(defaultPort),
    AWS_ENDPOINT: z.url(),
    AWS_REGION: z.string().trim().min(1),
    SNS_STAGE_EVENTS_TOPIC: z.string().trim().min(1),
    SQS_STAGE_EVENTS_QUEUE: z.string().trim().min(1),
    SQS_STAGE_EVENTS_DLQ: z.string().trim().min(1),
    DB_PASSWORD_SECRET_ID: z.string().trim().min(1),
    JWT_SIGNING_KEYS_SECRET_ID: z.string().trim().min(1),
    DATABASE_URI: z.url(),
    REDIS_URL: z.url(),
    COMPUTE_SERVICE_URL: z.url().default("http://localhost:8000"),
    JWT_ISSUER: z.string().trim().min(1).default("expense-api"),
    JWT_AUDIENCE: z.string().trim().min(1).default("expense-clients"),
    JWT_KEY_ID: z.string().trim().min(1).default("local-development-key"),
    JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(defaultJwtAccessTokenTtlSeconds),
    JWT_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(defaultJwtRefreshTokenTtlSeconds),
    EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive(),
    EXPENSE_WRITE_RATE_LIMIT_MAX: z.coerce.number().int().positive(),
    EXPENSE_WRITE_SLOW_DOWN_AFTER: z.coerce.number().int().positive(),
    EXPENSE_WRITE_DELAY_INCREMENT_MS: z.coerce.number().int().min(0).max(maxDelayMsBound),
    EXPENSE_WRITE_MAX_DELAY_MS: z.coerce.number().int().min(0).max(maxDelayMsBound)
  })
  .superRefine((config, context) => {
    if (config.EXPENSE_WRITE_SLOW_DOWN_AFTER >= config.EXPENSE_WRITE_RATE_LIMIT_MAX) {
      context.addIssue({
        code: "custom",
        path: ["EXPENSE_WRITE_SLOW_DOWN_AFTER"],
        message: "EXPENSE_WRITE_SLOW_DOWN_AFTER must be less than EXPENSE_WRITE_RATE_LIMIT_MAX."
      });
    }

    const databaseUrl = new URL(config.DATABASE_URI);
    const allowedDatabaseProtocols = new Set(["postgres:", "postgresql:"]);

    if (!allowedDatabaseProtocols.has(databaseUrl.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URI"],
        message: "DATABASE_URI must use the postgres or postgresql protocol."
      });
    }

    if (databaseUrl.password !== "" && config.NODE_ENV !== "test") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URI"],
        message: "DATABASE_URI must not contain a password; use DB_PASSWORD_SECRET_ID instead."
      });
    }

    const redisUrl = new URL(config.REDIS_URL);
    const allowedRedisProtocols = new Set(["redis:", "rediss:"]);

    if (!allowedRedisProtocols.has(redisUrl.protocol)) {
      context.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL must use the redis or rediss protocol."
      });
    }
  });

export type ApiRuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type Environment = Record<string, string | undefined>;

let cachedConfig: ApiRuntimeConfig | undefined;

export function loadApiRuntimeConfig(environment: Environment = process.env): ApiRuntimeConfig {
  return runtimeConfigSchema.parse(environment);
}

export function getApiRuntimeConfig(): ApiRuntimeConfig {
  cachedConfig ??= loadApiRuntimeConfig();

  return cachedConfig;
}

export function setApiRuntimeConfigForTest(config: ApiRuntimeConfig | undefined): void {
  cachedConfig = config;
}
