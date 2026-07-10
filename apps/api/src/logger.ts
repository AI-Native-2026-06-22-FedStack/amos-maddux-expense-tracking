import pino from "pino";

import { sensitiveLogCensor, sensitiveLogPaths } from "./log-redaction.js";

export { sensitiveLogCensor, sensitiveLogPaths };

export const logger = pino({
  redact: {
    paths: sensitiveLogPaths,
    censor: sensitiveLogCensor
  }
});
