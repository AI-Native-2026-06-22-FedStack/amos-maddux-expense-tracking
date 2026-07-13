import { z } from "zod";

import { auditEntryResults } from "../db/schema.js";

export const auditEntryResultSchema = z.enum(auditEntryResults);

export const auditEntryWriteSchema = z
  .object({
    tenantId: z.uuid(),
    expenseReportId: z.uuid(),
    actorId: z.string().min(1),
    action: z.string().min(1),
    reason: z.string().min(1),
    result: auditEntryResultSchema,
    occurredAt: z.date()
  })
  .strict();

export type AuditEntryWrite = z.infer<typeof auditEntryWriteSchema>;
