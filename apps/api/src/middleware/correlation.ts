import { randomUUID } from "node:crypto";

import { RequestHandler } from "express";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";
export const CORRELATION_ID_HEADER_LOWERCASE = "x-correlation-id";
export const CORRELATION_ID_LOG_FIELD = "correlationId";

export const bindCorrelationId: RequestHandler = (request, response, next) => {
  // eslint-disable-next-line security/detect-object-injection -- computed key is the fixed module-level constant CORRELATION_ID_HEADER_LOWERCASE, not attacker-controlled input.
  const correlationId = readCorrelationId(request.headers[CORRELATION_ID_HEADER_LOWERCASE]);
  const requestCorrelationId = correlationId ?? randomUUID();
  const childLogger = request.log.child({
    [CORRELATION_ID_LOG_FIELD]: requestCorrelationId
  });

  request.correlationId = requestCorrelationId;
  request.log = childLogger;
  response.log = childLogger;
  response.setHeader(CORRELATION_ID_HEADER, requestCorrelationId);

  next();
};

function readCorrelationId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}
