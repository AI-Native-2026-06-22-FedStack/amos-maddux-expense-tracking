import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import { CORRELATION_ID_HEADER } from "../middleware/correlation.js";
import { createComputeHealthClient } from "./compute-health-client.js";

const contextManager = new AsyncLocalStorageContextManager();

describe("ComputeHealthClient", () => {
  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  it("forwards the exact request correlation ID to services/compute", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "ok" }));
    const client = createComputeHealthClient("http://compute.example.test", fetchImpl);

    const isReady = await client.isReady({
      correlationId: "synthetic-incoming-correlation-id"
    });

    expect(isReady).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(new URL("http://compute.example.test/health"), {
      method: "GET",
      headers: {
        [CORRELATION_ID_HEADER]: "synthetic-incoming-correlation-id"
      }
    });
  });

  it("propagates the active OpenTelemetry trace context to services/compute", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: "ok" }));
    const client = createComputeHealthClient("http://compute.example.test", fetchImpl);

    await context.with(
      trace.setSpanContext(context.active(), {
        traceId: "1234567890abcdef1234567890abcdef",
        spanId: "1234567890abcdef",
        traceFlags: TraceFlags.SAMPLED
      }),
      async () => {
        await client.isReady({
          correlationId: "synthetic-traced-correlation-id"
        });
      }
    );

    expect(fetchImpl).toHaveBeenCalledWith(new URL("http://compute.example.test/health"), {
      method: "GET",
      headers: {
        [CORRELATION_ID_HEADER]: "synthetic-traced-correlation-id",
        traceparent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01"
      }
    });
  });
});
