import { redactTaxIdentifierForLog } from "./redaction.js";

export type TivsAuditOperation = "VerifyTaxpayer" | "GetTaxpayerStatus";
export type TivsAuditOutcome = "success" | "failure";

export interface TivsAuditLine {
  correlationId: string;
  durationMs: number;
  operation: TivsAuditOperation;
  outcome: TivsAuditOutcome;
  reason?: string;
  taxIdentifier: string;
}

export interface TivsAuditSink {
  write(line: TivsAuditLine): void;
}

export class ConsoleTivsAuditSink implements TivsAuditSink {
  write(line: TivsAuditLine): void {
    console.info(
      JSON.stringify({
        event: "tivs-acl.audit",
        correlationId: line.correlationId,
        durationMs: line.durationMs,
        operation: line.operation,
        outcome: line.outcome,
        ...(line.reason === undefined ? {} : { reason: line.reason }),
        taxIdentifier: redactTaxIdentifierForLog(line.taxIdentifier)
      })
    );
  }
}

export function createMemoryAuditSink(): TivsAuditSink & { lines: TivsAuditLine[] } {
  const lines: TivsAuditLine[] = [];

  return {
    lines,
    write(line: TivsAuditLine): void {
      lines.push({
        ...line,
        taxIdentifier: redactTaxIdentifierForLog(line.taxIdentifier)
      });
    }
  };
}
