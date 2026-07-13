import pino from "pino";

import {
  redactSensitiveLogObject,
  sensitiveLogCensor,
  sensitiveLogKeys,
  sensitiveLogPaths
} from "./log-redaction.js";

export { redactSensitiveLogObject, sensitiveLogCensor, sensitiveLogKeys, sensitiveLogPaths };

export const logger = pino({
  formatters: {
    log: redactSensitiveLogObject
  },
  redact: {
    paths: sensitiveLogPaths,
    censor: sensitiveLogCensor
  }
});
