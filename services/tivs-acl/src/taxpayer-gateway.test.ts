import { describe, expect, it, vi } from "vitest";

import { createMemoryAuditSink, type TivsAuditLine } from "./audit.js";
import {
  TaxpayerStatusNotFoundError,
  TivsTaxpayerVerificationGateway,
  redactTaxIdentifiersInLogLine,
  redactTaxIdentifierForLog
} from "./taxpayer-gateway.js";

describe("TivsTaxpayerVerificationGateway", () => {
  it("translates a match into an ExpenseFlow verification result", async () => {
    const soapOperations = createSoapOperations({
      verifyTaxpayer: [
        {
          MatchCode: "0",
          TINType: "EIN",
          VerifiedName: "SYNTHETIC GOVERNMENT SERVICES LLC"
        }
      ]
    });
    const gateway = new TivsTaxpayerVerificationGateway(soapOperations);

    const result = await gateway.verifyTaxpayer({
      legalName: "Synthetic Government Services LLC",
      taxIdentifier: "12-3456789",
      taxIdentifierType: "ein"
    });

    expect(soapOperations.verifyTaxpayer).toHaveBeenCalledWith({
      LegalName: "Synthetic Government Services LLC",
      TIN: "12-3456789",
      TINType: "EIN"
    });
    expect(result).toEqual({
      matched: true,
      reason: "matched",
      registeredName: "SYNTHETIC GOVERNMENT SERVICES LLC",
      taxIdentifierType: "ein"
    });
  });

  it("translates VerifyTaxpayer unknown TIN code into a normal not-found result", async () => {
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        verifyTaxpayer: [
          {
            MatchCode: "2",
            TINType: "EIN"
          }
        ]
      })
    );

    await expect(
      gateway.verifyTaxpayer({
        legalName: "Synthetic Vendor LLC",
        taxIdentifier: "00-0000000",
        taxIdentifierType: "ein"
      })
    ).resolves.toEqual({
      matched: false,
      reason: "tin-not-found",
      taxIdentifierType: "ein"
    });
  });

  it.each([
    ["1", "tin-not-issued"],
    ["3", "legal-name-mismatch"]
  ] as const)("translates VerifyTaxpayer match code %s", async (matchCode, reason) => {
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        verifyTaxpayer: [
          {
            MatchCode: matchCode,
            TINType: "SSN"
          }
        ]
      })
    );

    await expect(
      gateway.verifyTaxpayer({
        legalName: "Synthetic Taxpayer",
        taxIdentifier: "219-09-9999",
        taxIdentifierType: "ssn"
      })
    ).resolves.toMatchObject({
      matched: false,
      reason,
      taxIdentifierType: "ssn"
    });
  });

  it("translates taxpayer status standing and MMDDYYYY date", async () => {
    const soapOperations = createSoapOperations({
      getTaxpayerStatus: [
        {
          AsOfDate: "01152026",
          Standing: "ACTIVE"
        }
      ]
    });
    const gateway = new TivsTaxpayerVerificationGateway(soapOperations);

    const result = await gateway.getTaxpayerStanding({
      taxIdentifier: "12-3456789",
      taxIdentifierType: "ein"
    });

    expect(soapOperations.getTaxpayerStatus).toHaveBeenCalledWith({
      TIN: "12-3456789",
      TINType: "EIN"
    });
    expect(result).toEqual({
      asOf: new Date("2026-01-15T00:00:00.000Z"),
      standing: "active",
      taxIdentifierType: "ein"
    });
  });

  it("maps TaxpayerNotFoundFault to a typed ExpenseFlow domain error", async () => {
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        getTaxpayerStatusError: createTaxpayerNotFoundFault()
      })
    );

    await expect(
      gateway.getTaxpayerStanding({
        taxIdentifier: "00-0000000",
        taxIdentifierType: "ein"
      })
    ).rejects.toMatchObject({
      kind: "taxpayer-status-not-found",
      name: "TaxpayerStatusNotFoundError",
      redactedTaxIdentifier: "[redacted-tax-identifier-last4:0000]"
    });
  });

  it("maps namespaced TaxpayerNotFoundFault detail to the typed domain error", async () => {
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        getTaxpayerStatusError: createTaxpayerNotFoundFault("ns1:TaxpayerNotFoundFault")
      })
    );

    await expect(
      gateway.getTaxpayerStanding({
        taxIdentifier: "00-0000000",
        taxIdentifierType: "ein"
      })
    ).rejects.toThrow(TaxpayerStatusNotFoundError);
  });

  it("does not classify unrelated SOAP faults by message text alone", async () => {
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        getTaxpayerStatusError: Object.assign(
          new Error("Synthetic validation mentions TaxpayerNotFoundFault documentation."),
          {
            root: {
              Envelope: {
                Body: {
                  Fault: {
                    detail: {
                      ValidationFault: {
                        FaultCode: "VALIDATION"
                      }
                    }
                  }
                }
              }
            }
          }
        )
      })
    );

    await expect(
      gateway.getTaxpayerStanding({
        taxIdentifier: "12-3456789",
        taxIdentifierType: "ein"
      })
    ).rejects.toThrow("Synthetic validation mentions TaxpayerNotFoundFault documentation.");
  });

  it("audits successful and failed calls with redacted identifiers", async () => {
    const auditSink = createMemoryAuditSink();
    const gateway = new TivsTaxpayerVerificationGateway(
      createSoapOperations({
        getTaxpayerStatusError: createTaxpayerNotFoundFault(),
        verifyTaxpayer: [
          {
            MatchCode: "0",
            TINType: "EIN"
          }
        ]
      }),
      auditSink,
      createSteppedClock([10, 18, 20, 29])
    );

    await gateway.verifyTaxpayer({
      correlationId: "synthetic-success-correlation-id",
      legalName: "Synthetic Vendor LLC",
      taxIdentifier: "12-3456789",
      taxIdentifierType: "ein"
    });
    await expect(
      gateway.getTaxpayerStanding({
        correlationId: "synthetic-failure-correlation-id",
        taxIdentifier: "00-0000000",
        taxIdentifierType: "ein"
      })
    ).rejects.toThrow(TaxpayerStatusNotFoundError);

    expect(auditSink.lines).toEqual([
      {
        correlationId: "synthetic-success-correlation-id",
        durationMs: 8,
        operation: "VerifyTaxpayer",
        outcome: "success",
        taxIdentifier: "[redacted-tax-identifier-last4:6789]"
      },
      {
        correlationId: "synthetic-failure-correlation-id",
        durationMs: 9,
        operation: "GetTaxpayerStatus",
        outcome: "failure",
        reason: "taxpayer-status-not-found",
        taxIdentifier: "[redacted-tax-identifier-last4:0000]"
      }
    ] satisfies TivsAuditLine[]);
  });
});

describe("redactTaxIdentifierForLog", () => {
  it("shows only the last four digits for EIN and SSN-shaped values", () => {
    expect(redactTaxIdentifierForLog("12-3456789")).toBe("[redacted-tax-identifier-last4:6789]");
    expect(redactTaxIdentifierForLog("219-09-9999")).toBe("[redacted-tax-identifier-last4:9999]");
  });

  it("uses the redacted identifier in domain error messages", () => {
    const error = new TaxpayerStatusNotFoundError("12-3456789");

    expect(error.message).toContain("[redacted-tax-identifier-last4:6789]");
    expect(error.message).not.toContain("12-3456789");
    expect(error.message).not.toContain("3456789");
  });

  it("redacts EIN and SSN-shaped identifiers in log lines", () => {
    const redactedLine = redactTaxIdentifiersInLogLine(
      "Synthetic lookup failed for EIN 12-3456789 and SSN 219-09-9999."
    );

    expect(redactedLine).toContain("[redacted-tax-identifier-last4:6789]");
    expect(redactedLine).toContain("[redacted-tax-identifier-last4:9999]");
    expect(redactedLine).not.toContain("12-3456789");
    expect(redactedLine).not.toContain("219-09-9999");
    expect(redactedLine).not.toContain("3456789");
    expect(redactedLine).not.toContain("09-9999");
  });
});

function createSoapOperations(options: {
  getTaxpayerStatus?: [
    {
      AsOfDate: string;
      Standing: "ACTIVE" | "INACTIVE" | "SUSPENDED";
    }
  ];
  getTaxpayerStatusError?: Error;
  verifyTaxpayer?: [
    {
      MatchCode: "0" | "1" | "2" | "3";
      TINType: "EIN" | "SSN";
      VerifiedName?: string;
    }
  ];
}) {
  return {
    getTaxpayerStatus: vi.fn().mockImplementation(() => {
      if (options.getTaxpayerStatusError !== undefined) {
        throw options.getTaxpayerStatusError;
      }

      return Promise.resolve({
        body: options.getTaxpayerStatus?.[0] ?? {
          AsOfDate: "01152026",
          Standing: "ACTIVE"
        }
      });
    }),
    verifyTaxpayer: vi.fn().mockResolvedValue({
      body: options.verifyTaxpayer?.[0] ?? {
        MatchCode: "0",
        TINType: "EIN",
        VerifiedName: "SYNTHETIC GOVERNMENT SERVICES LLC"
      }
    })
  };
}

function createTaxpayerNotFoundFault(elementName = "TaxpayerNotFoundFault"): Error {
  const error = new Error("Synthetic TaxpayerNotFoundFault");

  return Object.assign(error, {
    root: {
      Envelope: {
        Body: {
          Fault: {
            detail: {
              [elementName]: {
                FaultCode: "TAXPAYER_NOT_FOUND",
                FaultReason: "Synthetic missing taxpayer."
              }
            }
          }
        }
      }
    }
  });
}

function createSteppedClock(values: number[]): () => number {
  let index = 0;

  return () => values[index++] ?? values.at(-1) ?? 0;
}
