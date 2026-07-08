import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import request from "supertest";

import { createApp } from "../src/app.js";
import { auditEntry, stageTransition } from "../src/db/schema.js";
import { readCaseQueue } from "../src/repository/case-queue.js";
import type { CaseQueueQueryExecutor } from "../src/repository/case-queue.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000501";
const tenantB = "00000000-0000-4000-8000-000000000502";
const submitterId = "synthetic-submitter-00000000-0000-4000-8000-000000000503";

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
    const createResponse = await request(app).post("/expense-reports").send({
      tenantId: tenantA,
      submitterId
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
      .query({ tenantId: tenantA });

    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual(createResponse.body);

    const wrongTenantResponse = await request(app)
      .get(`/expense-reports/${reportId}`)
      .query({ tenantId: tenantB });

    expect(wrongTenantResponse.status).toBe(404);

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
