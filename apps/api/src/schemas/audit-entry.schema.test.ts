import { describe, expect, it } from "vitest";

import { auditEntryWriteSchema } from "./audit-entry.schema.js";

const completeAuditEntry = {
  tenantId: "00000000-0000-4000-8000-000000000601",
  expenseReportId: "00000000-0000-4000-8000-000000000602",
  actorId: "synthetic-actor-00000000-0000-4000-8000-000000000603",
  action: "Expense Report Created",
  reason: "Expense Report created in Drafted stage.",
  result: "success",
  occurredAt: new Date("2026-01-01T00:00:00.000Z")
} as const;

const requiredFields = [
  "tenantId",
  "expenseReportId",
  "actorId",
  "action",
  "reason",
  "result",
  "occurredAt"
] as const;

describe("auditEntryWriteSchema", () => {
  it("parses a complete audit entry", () => {
    expect(auditEntryWriteSchema.parse(completeAuditEntry)).toEqual(completeAuditEntry);
  });

  it("rejects an audit entry missing result before storage", () => {
    const missingResult: Record<string, unknown> = { ...completeAuditEntry };
    delete missingResult.result;

    expect(() => auditEntryWriteSchema.parse(missingResult)).toThrow();
  });

  it.each(requiredFields)("rejects null for required field %s", (field) => {
    const entryWithNull = {
      ...completeAuditEntry,
      [field]: null
    };

    expect(() => auditEntryWriteSchema.parse(entryWithNull)).toThrow();
  });

  it("rejects extra fields that are not part of the audit schema", () => {
    const entryWithExtraField = {
      ...completeAuditEntry,
      details: "Synthetic extra detail."
    };

    expect(() => auditEntryWriteSchema.parse(entryWithExtraField)).toThrow();
  });
});
