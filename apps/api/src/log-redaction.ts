import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SensitiveLogFieldConfig {
  censor: string;
  node: {
    keys: string[];
    paths: string[];
  };
}

const configPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../config/sensitive-log-fields.json"
);
const sensitiveLogFieldConfig = JSON.parse(
  readFileSync(configPath, "utf-8")
) as SensitiveLogFieldConfig;

export const sensitiveLogCensor = sensitiveLogFieldConfig.censor;
export const sensitiveLogKeys = new Set(sensitiveLogFieldConfig.node.keys);
export const sensitiveLogPaths = sensitiveLogFieldConfig.node.paths;

export function redactSensitiveLogObject(
  value: Record<string, unknown>
): Record<string, unknown> {
  return redactSensitiveLogValue(value) as Record<string, unknown>;
}

function redactSensitiveLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveLogValue(item));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      sensitiveLogKeys.has(key) ? sensitiveLogCensor : redactSensitiveLogValue(child)
    ])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;

  return prototype === Object.prototype || prototype === null;
}
