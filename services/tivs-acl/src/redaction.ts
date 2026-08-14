export function redactTaxIdentifierForLog(taxIdentifier: string): string {
  const digits = taxIdentifier.replace(/\D/g, "");
  const lastFour = digits.slice(-4).padStart(4, "*");

  return `[redacted-tax-identifier-last4:${lastFour}]`;
}

export function redactTaxIdentifiersInLogLine(message: string): string {
  return message.replace(/\b(?:\d{2}-\d{7}|\d{3}-\d{2}-\d{4})\b/g, (taxIdentifier) =>
    redactTaxIdentifierForLog(taxIdentifier)
  );
}
