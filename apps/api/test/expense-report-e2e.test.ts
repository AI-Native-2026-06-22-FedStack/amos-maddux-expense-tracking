import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import jwt from "jsonwebtoken";
import pg from "pg";
import request from "supertest";

import { createApp } from "../src/app.js";
import { issueTokenPair, loadJwtRuntimeConfig } from "../src/auth/tokens.js";
import * as schema from "../src/db/schema.js";
import { auditEntry, lineItem, mileageEntry, receipt, stageTransition } from "../src/db/schema.js";
import { readCaseQueue } from "../src/repository/case-queue.js";
import type { CaseQueueQueryExecutor } from "../src/repository/case-queue.js";
import { createExpenseReportRepository } from "../src/repository/expense-report-repository.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000501";
const tenantB = "00000000-0000-4000-8000-000000000502";
const submitterId = "synthetic-submitter-00000000-0000-4000-8000-000000000503";
const clientSuppliedSubmitterId = "synthetic-submitter-00000000-0000-4000-8000-000000000504";

describe("Expense Report create and read end-to-end", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("persists a created Expense Report and reads it back for the same tenant", async () => {
    const app = createApp();
    const createResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .send({
        draftType: "mileage",
        dueDate: "2026-08-03",
        mileageEntries: [
          {
            business_purpose: "Synthetic client support visit.",
            destination: "Synthetic Destination Office",
            miles: 18.25,
            origin: "Synthetic Origin Office",
            trip_date: "2026-08-01"
          }
        ],
        priority: "Normal"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toMatchObject({
      tenantId: tenantA,
      submitterId,
      currentStage: "Drafted"
    });
    expect(createResponse.body.id).toEqual(expect.any(String));

    const reportId = createResponse.body.id as string;
    const readResponse = await request(app)
      .get(`/v1/expense-reports/${reportId}`)
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }));

    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual(createResponse.body);

    const wrongTenantResponse = await request(app)
      .get(`/v1/expense-reports/${reportId}`)
      .set("Authorization", createBearerToken({ tenantId: tenantB, userId: submitterId }));

    expect(wrongTenantResponse.status).toBe(404);

    const clientTenantOverrideResponse = await request(app)
      .get(`/v1/expense-reports/${reportId}`)
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .query({ tenantId: tenantB });

    expect(clientTenantOverrideResponse.status).toBe(200);
    expect(clientTenantOverrideResponse.body.tenantId).toBe(tenantA);

    const caseQueue = await readCaseQueue(toCaseQueueExecutor(client), tenantA);
    expect(caseQueue).toContainEqual({
      stage: "Drafted",
      reportCount: 1,
      overdueCount: 0
    });

    const db = drizzle(client, { schema });
    const mileageRows = await db
      .select()
      .from(mileageEntry)
      .where(and(eq(mileageEntry.tenant_id, tenantA), eq(mileageEntry.expense_report_id, reportId)));
    const auditRows = await db
      .select()
      .from(auditEntry)
      .where(and(eq(auditEntry.tenantId, tenantA), eq(auditEntry.expenseReportId, reportId)));
    const transitionRows = await db
      .select()
      .from(stageTransition)
      .where(
        and(eq(stageTransition.tenantId, tenantA), eq(stageTransition.expenseReportId, reportId))
      );

    expect(mileageRows).toHaveLength(1);
    expect(mileageRows[0]).toMatchObject({
      tenant_id: tenantA,
      expense_report_id: reportId,
      trip_date: "2026-08-01",
      origin: "Synthetic Origin Office",
      destination: "Synthetic Destination Office",
      miles: "18.25",
      business_purpose: "Synthetic client support visit."
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      tenantId: tenantA,
      expenseReportId: reportId,
      actorId: submitterId,
      action: "Expense Report Created",
      reason: "Expense Report created in Drafted stage.",
      result: "success"
    });
    expect(auditRows[0]?.occurredAt).toBeInstanceOf(Date);
    for (const value of Object.values(auditRows[0] ?? {})) {
      expect(value).not.toBeNull();
    }

    const repository = createExpenseReportRepository(db);
    const auditTrail = await repository.listAuditEntries(reportId, tenantA);

    expect(auditTrail).toHaveLength(1);
    expect(auditTrail[0]?.id).toBe(auditRows[0]?.id);
    await expect(
      client.query("update audit_entry set action = $1 where id = $2", [
        "Synthetic Mutated Action",
        auditRows[0]?.id
      ])
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query("delete from audit_entry where id = $1", [auditRows[0]?.id])
    ).rejects.toThrow(/append-only/);

    expect(transitionRows).toHaveLength(1);
    expect(transitionRows[0]).toMatchObject({
      fromStage: null,
      toStage: "Drafted",
      actorId: submitterId
    });
  });

  it("rejects client-owned create fields from the shared write contract", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .send({
        draftType: "mileage",
        mileageEntries: [
          {
            business_purpose: "Synthetic client support visit.",
            destination: "Synthetic Destination Office",
            miles: 18.25,
            origin: "Synthetic Origin Office",
            trip_date: "2026-08-01"
          }
        ],
        priority: "Normal",
        submitterId: clientSuppliedSubmitterId,
        tenantId: tenantB
      });

    expect(response.status).toBe(400);
    const db = drizzle(client, { schema });
    await expect(db.select().from(schema.expenseReport)).resolves.toHaveLength(0);
  });

  it("persists an expense draft with line item and receipt metadata from the shared contract", async () => {
    const app = createApp();
    const createResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .send({
        draftType: "expense",
        dueDate: "2026-08-05",
        lineItems: [
          {
            amount_cents: 4250,
            category: "Meals",
            currency: "USD",
            merchant: "Synthetic Cafe",
            receipt: {
              amount_cents: 4250,
              currency: "USD",
              merchant: "Synthetic Cafe",
              receipt_date: "2026-08-02",
              receipt_number: "SYN-4250"
            }
          }
        ],
        priority: "High"
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toMatchObject({
      tenantId: tenantA,
      submitterId,
      currentStage: "Drafted",
      priority: "High",
      dueDate: "2026-08-05"
    });

    const reportId = createResponse.body.id as string;
    const db = drizzle(client, { schema });
    const lineItemRows = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.expense_report_id, reportId)));
    const receiptRows = await db
      .select()
      .from(receipt)
      .where(and(eq(receipt.tenant_id, tenantA), eq(receipt.expense_report_id, reportId)));
    const auditRows = await db
      .select()
      .from(auditEntry)
      .where(and(eq(auditEntry.tenantId, tenantA), eq(auditEntry.expenseReportId, reportId)));
    const transitionRows = await db
      .select()
      .from(stageTransition)
      .where(
        and(eq(stageTransition.tenantId, tenantA), eq(stageTransition.expenseReportId, reportId))
      );

    expect(lineItemRows).toHaveLength(1);
    expect(lineItemRows[0]).toMatchObject({
      tenant_id: tenantA,
      expense_report_id: reportId,
      merchant: "Synthetic Cafe",
      amount_cents: 4250,
      currency: "USD",
      category: "Meals"
    });
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]).toMatchObject({
      tenant_id: tenantA,
      expense_report_id: reportId,
      expense_line_item_id: lineItemRows[0]?.id,
      receipt_number: "SYN-4250",
      merchant: "Synthetic Cafe",
      receipt_date: "2026-08-02",
      amount_cents: 4250,
      currency: "USD"
    });
    expect(auditRows).toHaveLength(1);
    expect(transitionRows).toHaveLength(1);
  });

  it("rejects payloads outside the shared write contract without creating rows", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .send({
        draftType: "expense",
        lineItems: [
          {
            amount_cents: 0,
            category: "Meals",
            currency: "usd",
            merchant: "Synthetic Cafe",
            receipt: {
              amount_cents: 4250,
              currency: "USD",
              merchant: "Synthetic Cafe",
              receipt_date: "2026-08-02"
            }
          }
        ],
        priority: "High"
      });

    expect(response.status).toBe(400);
    const db = drizzle(client, { schema });
    await expect(db.select().from(schema.expenseReport)).resolves.toHaveLength(0);
    await expect(db.select().from(lineItem)).resolves.toHaveLength(0);
    await expect(db.select().from(receipt)).resolves.toHaveLength(0);
    await expect(db.select().from(mileageEntry)).resolves.toHaveLength(0);
  });

  it("reads tenant-scoped Approval Queue line items and excludes other tenants and stages", async () => {
    const db = drizzle(client, { schema });
    const managerApprovalReportId = "00000000-0000-4000-8000-000000000701";
    const apReviewReportId = "00000000-0000-4000-8000-000000000702";

    await seedReportWithLineItem(db, {
      amountCents: 55001,
      currentStage: "Manager Approval",
      flagged: true,
      glAccountCode: "6100",
      glAccountName: "Synthetic Meals Expense",
      lineItemId: "00000000-0000-4000-8000-000000000711",
      merchant: "Synthetic Flagged Cafe",
      reportId: managerApprovalReportId,
      tenantId: tenantA
    });
    await seedReportWithLineItem(db, {
      currentStage: "AP Review",
      lineItemId: "00000000-0000-4000-8000-000000000712",
      merchant: "Synthetic AP Supplies",
      reportId: apReviewReportId,
      tenantId: tenantA
    });
    await seedReportWithLineItem(db, {
      currentStage: "Manager Approval",
      lineItemId: "00000000-0000-4000-8000-000000000713",
      merchant: "Synthetic Other Tenant",
      reportId: "00000000-0000-4000-8000-000000000703",
      tenantId: tenantB
    });
    await seedReportWithLineItem(db, {
      currentStage: "Drafted",
      lineItemId: "00000000-0000-4000-8000-000000000714",
      merchant: "Synthetic Draft Merchant",
      reportId: "00000000-0000-4000-8000-000000000704",
      tenantId: tenantA
    });

    const response = await request(createApp())
      .get("/v1/expense-reports/approval-line-items")
      .set("Authorization", createBearerToken({ tenantId: tenantA, roles: ["Department Manager"] }));

    expect(response.status).toBe(200);
    expect(response.body.lineItems).toEqual([
      expect.objectContaining({
        reportId: managerApprovalReportId,
        lineItemId: "00000000-0000-4000-8000-000000000711",
        merchant: "Synthetic Flagged Cafe",
        amountCents: 55001,
        currency: "USD",
        flagged: true,
        flagCleared: false,
        glAccountCode: "6100",
        glAccountName: "Synthetic Meals Expense",
        managerReviewStatus: "pending"
      }),
      expect.objectContaining({
        reportId: apReviewReportId,
        lineItemId: "00000000-0000-4000-8000-000000000712",
        merchant: "Synthetic AP Supplies",
        reportStage: "AP Review"
      })
    ]);
  });

  it("persists Approval Queue row actions and audit entries", async () => {
    const db = drizzle(client, { schema });
    const reportId = "00000000-0000-4000-8000-000000000721";
    const lineItemId = "00000000-0000-4000-8000-000000000731";

    await seedReportWithLineItem(db, {
      amountCents: 72500,
      currentStage: "Manager Approval",
      flagged: true,
      lineItemId,
      merchant: "Synthetic Review Cafe",
      reportId,
      tenantId: tenantA
    });

    const app = createApp();
    const auth = createBearerToken({
      tenantId: tenantA,
      userId: submitterId,
      roles: ["Department Manager"]
    });
    const approveResponse = await request(app)
      .post(`/v1/expense-reports/${reportId}/line-items/${lineItemId}/approve`)
      .set("Authorization", auth)
      .send();

    expect(approveResponse.status).toBe(200);
    expect(approveResponse.body).toMatchObject({
      reportId,
      lineItemId,
      managerReviewStatus: "approved",
      flagCleared: false
    });

    const clearResponse = await request(app)
      .post(`/v1/expense-reports/${reportId}/line-items/${lineItemId}/clear-flag`)
      .set("Authorization", auth)
      .send();

    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body).toMatchObject({
      reportId,
      lineItemId,
      flagCleared: true
    });

    const [persistedLineItem] = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, lineItemId)));
    const auditRows = await db
      .select()
      .from(auditEntry)
      .where(and(eq(auditEntry.tenantId, tenantA), eq(auditEntry.expenseReportId, reportId)));

    expect(persistedLineItem).toMatchObject({
      manager_review_status: "approved",
      flag_cleared: true
    });
    expect(auditRows.map((row) => row.action)).toEqual([
      "Expense Line Item Approved",
      "Expense Line Item Flag Cleared"
    ]);
  });

  it("persists AP Review deductible changes and rejects wrong-stage changes without partial updates", async () => {
    const db = drizzle(client, { schema });
    const apReportId = "00000000-0000-4000-8000-000000000741";
    const apLineItemId = "00000000-0000-4000-8000-000000000751";
    const managerReportId = "00000000-0000-4000-8000-000000000742";
    const managerLineItemId = "00000000-0000-4000-8000-000000000752";

    await seedReportWithLineItem(db, {
      currentStage: "AP Review",
      lineItemId: apLineItemId,
      merchant: "Synthetic AP Review Merchant",
      reportId: apReportId,
      tenantId: tenantA
    });
    await seedReportWithLineItem(db, {
      currentStage: "Manager Approval",
      lineItemId: managerLineItemId,
      merchant: "Synthetic Manager Merchant",
      reportId: managerReportId,
      tenantId: tenantA
    });

    const app = createApp();
    const financeAuth = createBearerToken({ tenantId: tenantA, roles: ["Finance Admin"] });
    const successResponse = await request(app)
      .patch(`/v1/expense-reports/${apReportId}/line-items/${apLineItemId}/deductible`)
      .set("Authorization", financeAuth)
      .send({ deductible: true });

    expect(successResponse.status).toBe(200);
    expect(successResponse.body).toMatchObject({
      deductible: true,
      reportStage: "AP Review"
    });

    const failureResponse = await request(app)
      .patch(`/v1/expense-reports/${managerReportId}/line-items/${managerLineItemId}/deductible`)
      .set("Authorization", financeAuth)
      .send({ deductible: true });

    expect(failureResponse.status).toBe(409);

    const rows = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, managerLineItemId)));

    expect(rows[0]?.deductible).toBe(false);
  });

  it("rejects Approval Queue writes for the wrong tenant and wrong role", async () => {
    const db = drizzle(client, { schema });
    const reportId = "00000000-0000-4000-8000-000000000761";
    const lineItemId = "00000000-0000-4000-8000-000000000771";

    await seedReportWithLineItem(db, {
      currentStage: "Manager Approval",
      lineItemId,
      merchant: "Synthetic Tenant Guard Merchant",
      reportId,
      tenantId: tenantA
    });

    const app = createApp();
    const wrongTenantResponse = await request(app)
      .post(`/v1/expense-reports/${reportId}/line-items/${lineItemId}/approve`)
      .set("Authorization", createBearerToken({ tenantId: tenantB, roles: ["Department Manager"] }))
      .send();
    const employeeResponse = await request(app)
      .post(`/v1/expense-reports/${reportId}/line-items/${lineItemId}/approve`)
      .set("Authorization", createBearerToken({ tenantId: tenantA, roles: ["Employee"] }))
      .send();

    expect(wrongTenantResponse.status).toBe(409);
    expect(employeeResponse.status).toBe(403);

    const rows = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, lineItemId)));

    expect(rows[0]?.manager_review_status).toBe("pending");
  });

  it("rejects Expense Report creation without a token", async () => {
    const response = await request(createApp()).post("/v1/expense-reports").send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401
    });
  });

  it("rejects Expense Report reads without a token", async () => {
    const response = await request(createApp()).get(
      "/v1/expense-reports/00000000-0000-4000-8000-000000000599"
    );

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401
    });
  });

  it("rejects invalid and expired access tokens", async () => {
    const app = createApp();

    const invalidResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", "Bearer synthetic-invalid-token")
      .send({});
    const expiredResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createExpiredBearerToken())
      .send({});

    expect(invalidResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  it("rejects wrong-audience and wrong-issuer access tokens", async () => {
    const app = createApp();

    const wrongAudienceResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ audience: "synthetic-wrong-audience" }))
      .send({});
    const wrongIssuerResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ issuer: "synthetic-wrong-issuer" }))
      .send({});

    expect(wrongAudienceResponse.status).toBe(401);
    expect(wrongIssuerResponse.status).toBe(401);
  });
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for Expense Report end-to-end tests.");
  }

  return process.env.DATABASE_URI;
}

function toCaseQueueExecutor(client: pg.Client): CaseQueueQueryExecutor {
  return {
    async query(sql: string, params: readonly [tenantId: string]) {
      const queryParams = sql.includes("$1") ? [...params] : [];
      const result = await client.query(sql, queryParams);

      return { rows: result.rows };
    }
  };
}

function createBearerToken(
  overrides: {
    tenantId?: string;
    userId?: string;
    roles?: string[];
    issuer?: string;
    audience?: string;
  } = {}
): string {
  if (overrides.issuer === undefined && overrides.audience === undefined) {
    const tokenPair = issueTokenPair({
      tenantId: overrides.tenantId ?? tenantA,
      userId: overrides.userId ?? submitterId,
      roles: overrides.roles ?? ["Employee"]
    });

    return `Bearer ${tokenPair.accessToken}`;
  }

  const config = loadJwtRuntimeConfig();
  const accessToken = jwt.sign(
    {
      tenantId: overrides.tenantId ?? tenantA,
      roles: overrides.roles ?? ["Employee"]
    },
    config.privateKeyPem,
    {
      algorithm: "RS256",
      keyid: config.keyId,
      issuer: overrides.issuer ?? config.issuer,
      audience: overrides.audience ?? config.audience,
      expiresIn: config.accessTokenTtlSeconds,
      subject: overrides.userId ?? submitterId
    }
  );

  return `Bearer ${accessToken}`;
}

function createExpiredBearerToken(): string {
  const config = loadJwtRuntimeConfig();
  const accessToken = jwt.sign(
    {
      tenantId: tenantA,
      roles: ["Employee"]
    },
    config.privateKeyPem,
    {
      algorithm: "RS256",
      keyid: config.keyId,
      issuer: config.issuer,
      audience: config.audience,
      expiresIn: -1,
      subject: submitterId
    }
  );

  return `Bearer ${accessToken}`;
}

async function seedReportWithLineItem(
  db: NodePgDatabase<typeof schema>,
  options: {
    amountCents?: number;
    currentStage: schema.ExpenseReportSelect["currentStage"];
    flagged?: boolean;
    glAccountCode?: string | null;
    glAccountName?: string | null;
    lineItemId: string;
    merchant: string;
    reportId: string;
    tenantId: string;
  }
): Promise<void> {
  await db.insert(schema.expenseReport).values({
    id: options.reportId,
    tenantId: options.tenantId,
    submitterId,
    currentStage: options.currentStage,
    priority: "Normal"
  });
  await db.insert(lineItem).values({
    id: options.lineItemId,
    tenant_id: options.tenantId,
    expense_report_id: options.reportId,
    merchant: options.merchant,
    amount_cents: options.amountCents ?? 4250,
    currency: "USD",
    category: "Meals",
    flagged: options.flagged ?? false,
    gl_coding_status: options.glAccountCode === undefined ? null : "mapped",
    gl_code_id:
      options.glAccountCode === undefined ? null : "00000000-0000-4000-8000-000000000799",
    gl_account_code: options.glAccountCode ?? null,
    gl_account_name: options.glAccountName ?? null,
    gl_normal_balance: options.glAccountCode === undefined ? null : "debit"
  });
}
