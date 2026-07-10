import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface SensitiveLogFieldConfig {
  censor: string;
  node: {
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
export const sensitiveLogPaths = sensitiveLogFieldConfig.node.paths;
