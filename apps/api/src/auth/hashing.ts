import argon2 from "argon2";

const defaultMemoryCost = 19456;
const defaultTimeCost = 2;
const defaultParallelism = 1;

export async function hashPassword(plaintextPassword: string): Promise<string> {
  return argon2.hash(plaintextPassword, {
    type: argon2.argon2id,
    memoryCost: readPositiveIntegerEnv("ARGON2_MEMORY_COST", defaultMemoryCost),
    timeCost: readPositiveIntegerEnv("ARGON2_TIME_COST", defaultTimeCost),
    parallelism: readPositiveIntegerEnv("ARGON2_PARALLELISM", defaultParallelism)
  });
}

export function verifyPasswordHash(
  passwordHash: string,
  plaintextPassword: string
): Promise<boolean> {
  return argon2.verify(passwordHash, plaintextPassword);
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }

  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue < defaultValue) {
    throw new Error(`${name} must be an integer greater than or equal to ${defaultValue}.`);
  }

  return parsedValue;
}
