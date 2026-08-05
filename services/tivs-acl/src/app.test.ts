import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";

import { createTivsAclApp } from "./app.js";
import { TaxpayerStatusNotFoundError } from "./index.js";
import type { ExpenseFlowTaxpayerVerificationGateway } from "./index.js";

describe("createTivsAclApp", () => {
  it("returns the verification DTO without SOAP fields", async () => {
    const gateway = createGateway({
      verifyTaxpayer: vi.fn(async () => ({
        matched: true,
        reason: "matched" as const,
        registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC",
        taxIdentifierType: "ein" as const
      }))
    });

    const response = await inject(createTivsAclApp(gateway), {
      method: "POST",
      url: "/v1/taxpayer-verifications",
      headers: {
        "x-correlation-id": "synthetic-correlation-id"
      },
      payload: {
        legalName: "Synthetic Government Services LLC",
        taxIdentifier: "12-3456789",
        taxIdentifierType: "ein"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      matched: true,
      reason: "matched",
      registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC",
      taxIdentifierType: "ein"
    });
    expect(response.json()).not.toHaveProperty("MatchCode");
    expect(response.json()).not.toHaveProperty("TINType");
    expect(gateway.verifyTaxpayer).toHaveBeenCalledWith({
      correlationId: "synthetic-correlation-id",
      legalName: "Synthetic Government Services LLC",
      taxIdentifier: "12-3456789",
      taxIdentifierType: "ein"
    });
  });

  it("returns taxpayer standing with an ISO date string", async () => {
    const gateway = createGateway({
      getTaxpayerStanding: vi.fn(async () => ({
        asOf: new Date("2026-01-15T00:00:00.000Z"),
        standing: "active" as const,
        taxIdentifierType: "ein" as const
      }))
    });

    const response = await inject(createTivsAclApp(gateway), {
      method: "POST",
      url: "/v1/taxpayer-status",
      payload: { taxIdentifier: "12-3456789", taxIdentifierType: "ein" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      asOf: "2026-01-15T00:00:00.000Z",
      standing: "active",
      taxIdentifierType: "ein"
    });
    expect(response.json()).not.toHaveProperty("AsOfDate");
    expect(response.json()).not.toHaveProperty("Standing");
  });

  it("returns the typed domain error for missing taxpayer status", async () => {
    const gateway = createGateway({
      getTaxpayerStanding: vi.fn(async () => {
        throw new TaxpayerStatusNotFoundError("00-0000000");
      })
    });

    const response = await inject(createTivsAclApp(gateway), {
      method: "POST",
      url: "/v1/taxpayer-status",
      payload: { taxIdentifier: "00-0000000", taxIdentifierType: "ein" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "taxpayer-status-not-found",
      taxIdentifier: "[redacted-tax-identifier-last4:0000]"
    });
    expect(response.payload).not.toContain("00-0000000");
  });

  it("returns 503 for open-breaker failures instead of taxpayer-not-found", async () => {
    const gateway = createGateway({
      getTaxpayerStanding: vi.fn(async () => {
        throw new Error("Breaker is open");
      })
    });

    const response = await inject(createTivsAclApp(gateway), {
      method: "POST",
      url: "/v1/taxpayer-status",
      payload: { taxIdentifier: "12-3456789", taxIdentifierType: "ein" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      title: "TIVS Unavailable",
      status: 503
    });
  });
});

function createGateway(
  overrides: Partial<ExpenseFlowTaxpayerVerificationGateway>
): ExpenseFlowTaxpayerVerificationGateway {
  return {
    getTaxpayerStanding: vi.fn(),
    verifyTaxpayer: vi.fn(),
    ...overrides
  } as ExpenseFlowTaxpayerVerificationGateway;
}
