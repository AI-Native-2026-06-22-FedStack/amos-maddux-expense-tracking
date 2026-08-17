import type { RequestHandler } from "express";

import {
  readActiveTraceId,
  readTraceIdFromTraceparent,
  TRACE_ID_LOG_FIELD
} from "../telemetry/trace-context.js";

export const bindTraceId: RequestHandler = (request, response, next) => {
  const traceId = readActiveTraceId() ?? readTraceIdFromTraceparent(request.headers.traceparent);

  if (traceId === undefined) {
    next();
    return;
  }

  const childLogger = request.log.child({
    [TRACE_ID_LOG_FIELD]: traceId
  });

  request.traceId = traceId;
  request.log = childLogger;
  response.log = childLogger;

  next();
};
