import { afterEach, describe, expect, it, vi } from "vitest";

import { createTivsAclClient } from "./tivs-acl-client.js";

describe("createTivsAclClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates employer EIN through the ACL REST DTO", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        matched: true,
        reason: "matched",
        registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC",
        taxIdentifierType: "ein"
      })
    );
    const client = createTivsAclClient({
      baseUrl: "http://synthetic-tivs-acl.example.test",
      fetchImpl
    });

    await expect(
      client.validateEmployerEin({
        correlationId: "synthetic-correlation-id",
        employerEin: "12-3456789",
        employerLegalName: "Synthetic Government Services LLC"
      })
    ).resolves.toEqual({
      checked: true,
      matched: true,
      reason: "matched",
      registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://synthetic-tivs-acl.example.test/v1/taxpayer-verifications"),
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": "synthetic-correlation-id"
        },
        body: JSON.stringify({
          legalName: "Synthetic Government Services LLC",
          taxIdentifier: "12-3456789",
          taxIdentifierType: "ein"
        })
      })
    );
  });

  it("surfaces an unreachable ACL as a non-blocking validation result", async () => {
    const client = createTivsAclClient({
      baseUrl: "http://synthetic-tivs-acl.example.test",
      fetchImpl: vi.fn(async () => {
        throw new Error("Synthetic ACL outage.");
      })
    });

    await expect(
      client.validateEmployerEin({
        correlationId: "synthetic-correlation-id",
        employerEin: "12-3456789",
        employerLegalName: "Synthetic Government Services LLC"
      })
    ).resolves.toEqual({
      checked: false,
      reason: "acl-unavailable"
    });
  });

  it("times out ACL validation and returns a non-blocking unavailable result", async () => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Synthetic ACL timeout.", "AbortError")),
          { once: true }
        );
      });
    });
    const client = createTivsAclClient({
      baseUrl: "http://synthetic-tivs-acl.example.test",
      fetchImpl,
      timeoutMs: 25
    });

    const resultPromise = client.validateEmployerEin({
      correlationId: "synthetic-correlation-id",
      employerEin: "12-3456789",
      employerLegalName: "Synthetic Government Services LLC"
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      checked: false,
      reason: "acl-unavailable"
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://synthetic-tivs-acl.example.test/v1/taxpayer-verifications"),
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
  });
});
