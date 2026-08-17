import { redactTaxIdentifierForLog } from "../../services/tivs-acl/src/redaction.js";

// ruleid: no-taxpayer-id-in-error-log-ts
function logTaxpayerVerificationFailureKnownBad(taxIdentifier: string, error: Error): void {
  logger.error("Taxpayer verification failed", taxIdentifier, error);
}

// ok: no-taxpayer-id-in-error-log-ts
function logTaxpayerVerificationFailureKnownGood(taxIdentifier: string, error: Error): void {
  logger.error("Taxpayer verification failed", redactTaxIdentifierForLog(taxIdentifier), error);
}
