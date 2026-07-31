import {
  createTivsSoapClient,
  type TinTypeCode,
  type TivsSoapOperations
} from "./client.js";
import type { TivsRuntimeConfig } from "./config.js";
import { createResilientTivsSoapOperations } from "./resilient-soap-operations.js";
import { ConsoleTivsAuditSink, type TivsAuditSink, type TivsAuditOperation } from "./audit.js";
import { redactTaxIdentifierForLog } from "./redaction.js";
export { redactTaxIdentifierForLog, redactTaxIdentifiersInLogLine } from "./redaction.js";

export type TaxIdentifierType = "ein" | "ssn";

export type TaxpayerVerificationReason =
  | "matched"
  | "tin-not-issued"
  | "tin-not-found"
  | "legal-name-mismatch";

export interface TaxpayerVerificationRequest {
  correlationId?: string;
  legalName: string;
  taxIdentifier: string;
  taxIdentifierType: TaxIdentifierType;
}

export interface TaxpayerVerificationResult {
  matched: boolean;
  reason: TaxpayerVerificationReason;
  registeredName?: string;
  taxIdentifierType: TaxIdentifierType;
}

export type TaxpayerStanding = "active" | "inactive" | "suspended";

export interface TaxpayerStandingRequest {
  correlationId?: string;
  taxIdentifier: string;
  taxIdentifierType: TaxIdentifierType;
}

export interface TaxpayerStandingResult {
  asOf: Date;
  standing: TaxpayerStanding;
  taxIdentifierType: TaxIdentifierType;
}

export class TaxpayerStatusNotFoundError extends Error {
  readonly kind = "taxpayer-status-not-found";
  readonly redactedTaxIdentifier: string;

  constructor(taxIdentifier: string) {
    super(`Taxpayer status was not found for ${redactTaxIdentifierForLog(taxIdentifier)}.`);
    this.name = "TaxpayerStatusNotFoundError";
    this.redactedTaxIdentifier = redactTaxIdentifierForLog(taxIdentifier);
  }
}

export interface ExpenseFlowTaxpayerVerificationGateway {
  getTaxpayerStanding(request: TaxpayerStandingRequest): Promise<TaxpayerStandingResult>;
  verifyTaxpayer(request: TaxpayerVerificationRequest): Promise<TaxpayerVerificationResult>;
}

export async function createExpenseFlowTaxpayerVerificationGateway(
  config: TivsRuntimeConfig,
  auditSink: TivsAuditSink = new ConsoleTivsAuditSink()
): Promise<ExpenseFlowTaxpayerVerificationGateway> {
  return new TivsTaxpayerVerificationGateway(
    createResilientTivsSoapOperations(await createTivsSoapClient(config), config),
    auditSink
  );
}

export class TivsTaxpayerVerificationGateway implements ExpenseFlowTaxpayerVerificationGateway {
  constructor(
    private readonly soapOperations: TivsSoapOperations,
    private readonly auditSink: TivsAuditSink = new ConsoleTivsAuditSink(),
    private readonly now: () => number = () => Date.now()
  ) {}

  async verifyTaxpayer(
    request: TaxpayerVerificationRequest
  ): Promise<TaxpayerVerificationResult> {
    return this.audit("VerifyTaxpayer", request, async () => {
      const response = await this.soapOperations.verifyTaxpayer({
        LegalName: request.legalName,
        TIN: request.taxIdentifier,
        TINType: toSoapTinType(request.taxIdentifierType)
      });

      return {
        matched: response.body.MatchCode === "0",
        reason: toVerificationReason(response.body.MatchCode),
        ...(response.body.VerifiedName === undefined
          ? {}
          : { registeredName: response.body.VerifiedName }),
        taxIdentifierType: fromSoapTinType(response.body.TINType)
      };
    });
  }

  async getTaxpayerStanding(
    request: TaxpayerStandingRequest
  ): Promise<TaxpayerStandingResult> {
    return this.audit("GetTaxpayerStatus", request, async () => {
      const response = await this.soapOperations.getTaxpayerStatus({
        TIN: request.taxIdentifier,
        TINType: toSoapTinType(request.taxIdentifierType)
      });

      return {
        asOf: parseLegacyAsOfDate(response.body.AsOfDate),
        standing: toTaxpayerStanding(response.body.Standing),
        taxIdentifierType: request.taxIdentifierType
      };
    });
  }

  private async audit<TResult>(
    operation: TivsAuditOperation,
    request: { correlationId?: string; taxIdentifier: string },
    action: () => Promise<TResult>
  ): Promise<TResult> {
    const startedAt = this.now();

    try {
      const result = await action();

      this.auditSink.write({
        correlationId: request.correlationId ?? "missing-correlation-id",
        durationMs: this.now() - startedAt,
        operation,
        outcome: "success",
        taxIdentifier: request.taxIdentifier
      });

      return result;
    } catch (error) {
      if (isTaxpayerNotFoundFault(error)) {
        this.auditSink.write({
          correlationId: request.correlationId ?? "missing-correlation-id",
          durationMs: this.now() - startedAt,
          operation,
          outcome: "failure",
          reason: "taxpayer-status-not-found",
          taxIdentifier: request.taxIdentifier
        });
        throw new TaxpayerStatusNotFoundError(request.taxIdentifier);
      }

      this.auditSink.write({
        correlationId: request.correlationId ?? "missing-correlation-id",
        durationMs: this.now() - startedAt,
        operation,
        outcome: "failure",
        reason: error instanceof Error ? error.name : "unknown-error",
        taxIdentifier: request.taxIdentifier
      });

      throw error;
    }
  }
}

function toSoapTinType(taxIdentifierType: TaxIdentifierType): TinTypeCode {
  return taxIdentifierType === "ein" ? "EIN" : "SSN";
}

function fromSoapTinType(tinTypeCode: TinTypeCode): TaxIdentifierType {
  return tinTypeCode === "EIN" ? "ein" : "ssn";
}

function toVerificationReason(matchCode: "0" | "1" | "2" | "3"): TaxpayerVerificationReason {
  switch (matchCode) {
    case "0":
      return "matched";
    case "1":
      return "tin-not-issued";
    case "2":
      return "tin-not-found";
    case "3":
      return "legal-name-mismatch";
  }
}

function toTaxpayerStanding(standing: "ACTIVE" | "INACTIVE" | "SUSPENDED"): TaxpayerStanding {
  switch (standing) {
    case "ACTIVE":
      return "active";
    case "INACTIVE":
      return "inactive";
    case "SUSPENDED":
      return "suspended";
  }
}

function parseLegacyAsOfDate(value: string): Date {
  if (!/^\d{8}$/.test(value)) {
    throw new Error("TIVS AsOfDate must be an MMDDYYYY string.");
  }

  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(2, 4));
  const year = Number(value.slice(4, 8));
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    throw new Error("TIVS AsOfDate must be a valid MMDDYYYY date.");
  }

  return parsedDate;
}

function isTaxpayerNotFoundFault(error: unknown): boolean {
  const fault = getRecordProperty(getRecordProperty(error, "root"), "Envelope");
  const body = getRecordProperty(fault, "Body");
  const soapFault = getRecordProperty(body, "Fault");
  const detail = getRecordProperty(soapFault, "detail");

  return (
    getRecordProperty(detail, "TaxpayerNotFoundFault") !== undefined ||
    getStringProperty(error, "message").includes("TaxpayerNotFoundFault")
  );
}

function getRecordProperty(value: unknown, property: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const child = value[property];

  return isRecord(child) ? child : undefined;
}

function getStringProperty(value: unknown, property: string): string {
  if (!isRecord(value)) {
    return "";
  }

  const child = value[property];

  return typeof child === "string" ? child : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
