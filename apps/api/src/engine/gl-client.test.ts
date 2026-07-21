import { describe, expect, it, vi } from "vitest";

import { BoundaryContractError, UpstreamEngineError } from "../errors/problem-json.js";
import { createGlCodingEngineClient } from "./gl-client.js";

const validRequest = {
  line_items: [
    {
      line_item_id: "00000000-0000-4000-8000-000000000101",
      amount: "42.50",
      currency: "USD",
      category: "Meals"
    }
  ],
  mileage_entries: []
};

const validResponse = {
  coded_line_items: [
    {
      status: "mapped",
      line_item_id: "00000000-0000-4000-8000-000000000101",
      category: "Meals",
      gl_code_id: "00000000-0000-4000-8000-000000000301",
      account_code: "6100",
      account_name: "Synthetic Meals Expense",
      normal_balance: "debit",
      flagged: false
    }
  ],
  coded_mileage_entries: [],
  flagged_line_item: null
};

describe("GlCodingEngineClient", () => {
  it("caps retries with growing jittered waits for a downed engine", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("synthetic transport failure");
    }) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      random: () => 0.5,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).rejects.toThrow(
      UpstreamEngineError
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([150, 300]);
  });

  it("caps exponential retry backoff before applying multiplicative jitter", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("synthetic transport failure");
    }) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      maxAttempts: 4,
      baseBackoffMs: 100,
      maxBackoffMs: 250,
      random: () => 1,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).rejects.toThrow(
      UpstreamEngineError
    );

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([200, 250, 250]);
  });

  it("succeeds when a transient 5xx recovers on retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "synthetic transient" }, 503))
      .mockResolvedValueOnce(jsonResponse(validResponse, 200)) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      random: () => 0,
      sleep: async () => undefined
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).resolves.toEqual(
      validResponse
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "synthetic bad request" }, 400)
    ) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).rejects.toThrow(
      "GL coding engine rejected the request with status 400."
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed engine responses as boundary errors without retrying", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ coded_line_items: [] }, 200)
    ) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).rejects.toThrow(
      BoundaryContractError
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON 2xx engine responses as boundary errors without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("synthetic-not-json", { status: 200 })
    ) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(client.codeExpenseReport(validRequest, "synthetic-token")).rejects.toThrow(
      BoundaryContractError
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes a per-attempt abort signal and bearer token to the versioned endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(validResponse, 200)
    ) as unknown as typeof fetch;
    const client = createGlCodingEngineClient({
      baseUrl: "http://compute.example.test",
      fetchImpl
    });

    await client.codeExpenseReport(validRequest, "synthetic-token");

    expect(fetchImpl).toHaveBeenCalledWith(new URL("/v1/coding", "http://compute.example.test"), {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/json"
      },
      body: JSON.stringify(validRequest),
      signal: expect.any(AbortSignal)
    });
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}
