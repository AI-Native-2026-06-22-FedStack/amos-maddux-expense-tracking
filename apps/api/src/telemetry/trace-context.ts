import { context, trace } from "@opentelemetry/api";
import { TraceFlags } from "@opentelemetry/api";

export const TRACE_ID_LOG_FIELD = "traceId";

const TRACEPARENT_TRACE_ID_PATTERN = /^[\da-f]{32}$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";

export function injectActiveTraceContext(headers: Record<string, string>): Record<string, string> {
  const spanContext = readActiveSpanContext();
  if (spanContext !== undefined) {
    const sampledFlag =
      (spanContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? "01" : "00";
    headers.traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${sampledFlag}`;
  }

  return headers;
}

export function readActiveTraceId(): string | undefined {
  const spanContext = readActiveSpanContext();
  const traceId = spanContext?.traceId;

  return isUsableTraceId(traceId) ? traceId : undefined;
}

export function readTraceIdFromTraceparent(
  value: string | string[] | undefined
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const traceId = value.trim().split("-")[1];

  return isUsableTraceId(traceId) ? traceId : undefined;
}

function isUsableTraceId(value: string | undefined): value is string {
  return value !== undefined && value !== ZERO_TRACE_ID && TRACEPARENT_TRACE_ID_PATTERN.test(value);
}

function readActiveSpanContext(): ReturnType<typeof trace.getSpanContext> {
  return trace.getSpanContext(context.active()) ?? trace.getSpan(context.active())?.spanContext();
}
