import { describe, expect, it, vi } from "vitest";

import { createResilientTivsSoapOperations } from "./resilient-soap-operations.js";
import type { TivsRuntimeConfig } from "./config.js";
import type { TivsSoapOperations } from "./client.js";

const breakerConfig = {
  breakerErrorThresholdPercentage: 50,
  breakerResetTimeoutMs: 10_000,
  breakerTimeoutMs: 100,
  breakerVolumeThreshold: 3
} satisfies Pick<
  TivsRuntimeConfig,
  | "breakerErrorThresholdPercentage"
  | "breakerResetTimeoutMs"
  | "breakerTimeoutMs"
  | "breakerVolumeThreshold"
>;

describe("createResilientTivsSoapOperations", () => {
  it("does not trip the breaker on one transient error", async () => {
    const verifyTaxpayer = vi
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic transient TIVS failure."))
      .mockResolvedValue({
        body: {
          MatchCode: "0",
          TINType: "EIN"
        }
      });
    const operations = createResilientTivsSoapOperations(
      createSoapOperations({ verifyTaxpayer }),
      breakerConfig
    );

    await expect(
      operations.verifyTaxpayer({
        LegalName: "Synthetic Vendor LLC",
        TIN: "12-3456789",
        TINType: "EIN"
      })
    ).rejects.toThrow("Synthetic transient TIVS failure.");

    await expect(
      operations.verifyTaxpayer({
        LegalName: "Synthetic Vendor LLC",
        TIN: "12-3456789",
        TINType: "EIN"
      })
    ).resolves.toMatchObject({
      body: {
        MatchCode: "0"
      }
    });
  });

  it("opens after the configured volume and threshold are crossed", async () => {
    const verifyTaxpayer = vi.fn().mockRejectedValue(new Error("Synthetic TIVS outage."));
    const operations = createResilientTivsSoapOperations(
      createSoapOperations({ verifyTaxpayer }),
      breakerConfig
    );
    const request = {
      LegalName: "Synthetic Vendor LLC",
      TIN: "12-3456789",
      TINType: "EIN" as const
    };

    await expect(operations.verifyTaxpayer(request)).rejects.toThrow("Synthetic TIVS outage.");
    await expect(operations.verifyTaxpayer(request)).rejects.toThrow("Synthetic TIVS outage.");
    await expect(operations.verifyTaxpayer(request)).rejects.toThrow("Synthetic TIVS outage.");
    await expect(operations.verifyTaxpayer(request)).rejects.toThrow(/Breaker is open|open/);
    expect(verifyTaxpayer).toHaveBeenCalledTimes(3);
  });
});

function createSoapOperations(overrides: Partial<TivsSoapOperations>): TivsSoapOperations {
  return {
    getTaxpayerStatus: vi.fn(),
    verifyTaxpayer: vi.fn(),
    ...overrides
  } as TivsSoapOperations;
}
