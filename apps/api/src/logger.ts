import pino from "pino";

export const sensitiveLogPaths = [
  "req.headers.authorization",
  "request.headers.authorization",
  "headers.authorization",
  "authorization",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "credentials",
  "req.body",
  "request.body",
  "body",
  "receipt",
  "receiptData",
  "payment",
  "paymentData"
];

export const logger = pino({
  redact: {
    paths: sensitiveLogPaths,
    remove: true
  }
});
