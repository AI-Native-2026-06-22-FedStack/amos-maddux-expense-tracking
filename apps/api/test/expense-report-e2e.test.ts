import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import jwt from "jsonwebtoken";
import pg from "pg";
import request from "supertest";

import { createApp } from "../src/app.js";
import { issueTokenPair, loadJwtRuntimeConfig } from "../src/auth/tokens.js";
import { auditEntry, stageTransition } from "../src/db/schema.js";
import { readCaseQueue } from "../src/repository/case-queue.js";
import type { CaseQueueQueryExecutor } from "../src/repository/case-queue.js";

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
      .post("/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }))
      .send({
        tenantId: tenantB,
        submitterId: clientSuppliedSubmitterId
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
      .get(`/expense-reports/${reportId}`)
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId: submitterId }));

    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual(createResponse.body);

    const wrongTenantResponse = await request(app)
      .get(`/expense-reports/${reportId}`)
      .set("Authorization", createBearerToken({ tenantId: tenantB, userId: submitterId }));

    expect(wrongTenantResponse.status).toBe(404);

    const clientTenantOverrideResponse = await request(app)
      .get(`/expense-reports/${reportId}`)
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

    const db = drizzle(client);
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

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorId: submitterId,
      action: "Expense Report Created"
    });
    expect(transitionRows).toHaveLength(1);
    expect(transitionRows[0]).toMatchObject({
      fromStage: null,
      toStage: "Drafted",
      actorId: submitterId
    });
  });

  it("rejects Expense Report creation without a token", async () => {
    const response = await request(createApp()).post("/expense-reports").send({});

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401
    });
  });

  it("rejects Expense Report reads without a token", async () => {
    const response = await request(createApp()).get(
      "/expense-reports/00000000-0000-4000-8000-000000000599"
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
      .post("/expense-reports")
      .set("Authorization", "Bearer synthetic-invalid-token")
      .send({});
    const expiredResponse = await request(app)
      .post("/expense-reports")
      .set("Authorization", createExpiredBearerToken())
      .send({});

    expect(invalidResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  it("rejects wrong-audience and wrong-issuer access tokens", async () => {
    const app = createApp();

    const wrongAudienceResponse = await request(app)
      .post("/expense-reports")
      .set("Authorization", createBearerToken({ audience: "synthetic-wrong-audience" }))
      .send({});
    const wrongIssuerResponse = await request(app)
      .post("/expense-reports")
      .set("Authorization", createBearerToken({ issuer: "synthetic-wrong-issuer" }))
      .send({});

    expect(wrongAudienceResponse.status).toBe(401);
    expect(wrongIssuerResponse.status).toBe(401);
  });
});

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Expense Report end-to-end tests.");
  }

  return process.env.DATABASE_URL;
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
