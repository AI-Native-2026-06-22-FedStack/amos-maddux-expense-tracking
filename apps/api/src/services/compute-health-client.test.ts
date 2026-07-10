import { describe, expect, it, vi } from "vitest";

import { CORRELATION_ID_HEADER } from "../middleware/correlation.js";
import { createComputeHealthClient } from "./compute-health-client.js";

describe("ComputeHealthClient", () => {
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
});
