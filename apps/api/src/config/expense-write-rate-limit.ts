const maxDelayMsBound = 60_000;

export interface ExpenseWriteRateLimitConfig {
  redisUrl: string;
  expenseWriteRateLimitWindowMs: number;
  expenseWriteRateLimitMax: number;
  expenseWriteSlowDownAfter: number;
  expenseWriteDelayIncrementMs: number;
  expenseWriteMaxDelayMs: number;
}

type Environment = Record<string, string | undefined>;

export function loadExpenseWriteRateLimitConfig(
  environment: Environment = process.env
): ExpenseWriteRateLimitConfig {
  const config = {
    redisUrl: readRequiredString(environment, "REDIS_URL"),
    expenseWriteRateLimitWindowMs: readRequiredPositiveInteger(
      environment,
      "EXPENSE_WRITE_RATE_LIMIT_WINDOW_MS"
    ),
    expenseWriteRateLimitMax: readRequiredPositiveInteger(
      environment,
      "EXPENSE_WRITE_RATE_LIMIT_MAX"
    ),
    expenseWriteSlowDownAfter: readRequiredPositiveInteger(
      environment,
      "EXPENSE_WRITE_SLOW_DOWN_AFTER"
    ),
    expenseWriteDelayIncrementMs: readRequiredBoundedNonNegativeInteger(
      environment,
      "EXPENSE_WRITE_DELAY_INCREMENT_MS",
      maxDelayMsBound
    ),
    expenseWriteMaxDelayMs: readRequiredBoundedNonNegativeInteger(
      environment,
      "EXPENSE_WRITE_MAX_DELAY_MS",
      maxDelayMsBound
    )
  };

  if (config.expenseWriteSlowDownAfter >= config.expenseWriteRateLimitMax) {
    throw new Error(
      "EXPENSE_WRITE_SLOW_DOWN_AFTER must be less than EXPENSE_WRITE_RATE_LIMIT_MAX."
    );
  }

  return config;
}

function readRequiredString(environment: Environment, name: string): string {
  const value = environment[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function readRequiredPositiveInteger(environment: Environment, name: string): number {
  const value = readRequiredString(environment, name);
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

function readRequiredBoundedNonNegativeInteger(
  environment: Environment,
  name: string,
  maxValue: number
): number {
  const value = readRequiredString(environment, name);
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > maxValue) {
    throw new Error(`${name} must be an integer from 0 through ${maxValue}.`);
  }

  return parsedValue;
}
