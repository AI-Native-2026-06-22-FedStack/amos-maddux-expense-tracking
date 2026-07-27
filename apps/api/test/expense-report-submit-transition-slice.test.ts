import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { issueTokenPair, loadJwtRuntimeConfig } from "../src/auth/tokens.js";
import { setApiRuntimeConfigForTest } from "../src/config/runtime-config.js";
import * as schema from "../src/db/schema.js";
import { auditEntry, expenseReport, lineItem, stageTransition } from "../src/db/schema.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000701";
const tenantB = "00000000-0000-4000-8000-000000000702";
const employeeId = "synthetic-employee-00000000-0000-4000-8000-000000000703";
const managerId = "synthetic-manager-00000000-0000-4000-8000-000000000704";
const financeAdminId = "synthetic-finance-00000000-0000-4000-8000-000000000705";
const platformAdminId = "synthetic-platform-00000000-0000-4000-8000-000000000706";

describe("Expense Report submit and transition cross-service slice", () => {
  let client: pg.Client;
  let computeServer: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
    await ensureComputeGlSchema(client);
    await seedGlMappings(client, tenantA);

    const port = await findFreePort();
    const jwtConfig = loadJwtRuntimeConfig();
    computeServer = await startComputeServer(port, {
      DATABASE_URI: getDatabaseUrl(),
      JWT_PUBLIC_KEY_PEM: jwtConfig.publicKeyPem,
      JWT_KEY_ID: jwtConfig.keyId,
      JWT_ISSUER: jwtConfig.issuer,
      JWT_AUDIENCE: jwtConfig.audience,
      MILEAGE_REIMBURSEMENT_RATE: "0.67"
    });
    process.env.COMPUTE_SERVICE_URL = `http://127.0.0.1:${port}`;
    setApiRuntimeConfigForTest(undefined);
  });

  afterEach(async () => {
    await stopComputeServer(computeServer);
    await client.end();
    delete process.env.COMPUTE_SERVICE_URL;
    setApiRuntimeConfigForTest(undefined);
  });

  it("codes on submit, rejects cross-tenant and Employee transitions, gates flags, and sends back", async () => {
    const app = createApp({
      expenseReportIdempotencyMiddleware: (_request, _response, next) => {
        next();
      }
    });
    const db = drizzle(client, { schema });

    const createResponse = await request(app)
      .post("/v1/expense-reports")
      .set("Authorization", bearerToken(tenantA, employeeId, ["Employee"]))
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
        priority: "Normal"
      });
    expect(createResponse.status).toBe(201);
    const reportId = createResponse.body.id as string;

    const [createdLineItem] = await db
      .insert(lineItem)
      .values({
        tenant_id: tenantA,
        expense_report_id: reportId,
        merchant: "Synthetic Team Meal",
        amount_cents: 50001,
        currency: "USD",
        category: "Meals"
      })
      .returning();
    expect(createdLineItem).toBeDefined();
    const lineItemId = createdLineItem?.id;
    if (lineItemId === undefined) {
      throw new Error("Synthetic line item was not created.");
    }

    const crossTenantSubmit = await request(app)
      .post(`/v1/expense-reports/${reportId}/submit`)
      .set("Authorization", bearerToken(tenantB, employeeId, ["Employee"]))
      .set("Idempotency-Key", "synthetic-cross-tenant-submit")
      .send({});
    expect(crossTenantSubmit.status).toBe(404);

    const submitResponse = await request(app)
      .post(`/v1/expense-reports/${reportId}/submit`)
      .set("Authorization", bearerToken(tenantA, employeeId, ["Employee"]))
      .set("Idempotency-Key", "synthetic-submit-real-compute")
      .send({});
    expect(submitResponse.status).toBe(200);
    expect(submitResponse.body.currentStage).toBe("Submitted");

    const [codedLineItem] = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, lineItemId)));
    expect(codedLineItem).toMatchObject({
      flagged: true,
      flag_cleared: false,
      gl_coding_status: "mapped",
      gl_account_code: "6100",
      gl_account_name: "Synthetic Meals Expense",
      gl_normal_balance: "debit"
    });

    const employeeAdvance = await request(app)
      .post(`/v1/expense-reports/${reportId}/advance`)
      .set("Authorization", bearerToken(tenantA, employeeId, ["Employee"]))
      .set("Idempotency-Key", "synthetic-employee-advance")
      .send({});
    expect(employeeAdvance.status).toBe(403);

    const managerAdvance = await request(app)
      .post(`/v1/expense-reports/${reportId}/advance`)
      .set("Authorization", bearerToken(tenantA, managerId, ["Department Manager"]))
      .set("Idempotency-Key", "synthetic-manager-advance")
      .send({ reason: "Synthetic manager review." });
    expect(managerAdvance.status).toBe(200);
    expect(managerAdvance.body.currentStage).toBe("Manager Approval");

    const blockedByFlag = await request(app)
      .post(`/v1/expense-reports/${reportId}/advance`)
      .set("Authorization", bearerToken(tenantA, managerId, ["Department Manager"]))
      .set("Idempotency-Key", "synthetic-manager-flag-block")
      .send({});
    expect(blockedByFlag.status).toBe(409);

    await db
      .update(lineItem)
      .set({ flag_cleared: true })
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, lineItemId)));

    const apReview = await request(app)
      .post(`/v1/expense-reports/${reportId}/advance`)
      .set("Authorization", bearerToken(tenantA, managerId, ["Department Manager"]))
      .set("Idempotency-Key", "synthetic-manager-cleared-advance")
      .send({});
    expect(apReview.status).toBe(200);
    expect(apReview.body.currentStage).toBe("AP Review");

    const financeSendBack = await request(app)
      .post(`/v1/expense-reports/${reportId}/reject`)
      .set("Authorization", bearerToken(tenantA, financeAdminId, ["Finance Admin"]))
      .set("Idempotency-Key", "synthetic-finance-send-back")
      .send({ reason: "Synthetic receipt needs more detail." });
    expect(financeSendBack.status).toBe(403);

    const sentBack = await request(app)
      .post(`/v1/expense-reports/${reportId}/reject`)
      .set("Authorization", bearerToken(tenantA, platformAdminId, ["Platform Admin"]))
      .set("Idempotency-Key", "synthetic-platform-send-back")
      .send({ reason: "Synthetic receipt needs more detail." });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body.currentStage).toBe("Drafted");

    const [finalReport] = await db
      .select()
      .from(expenseReport)
      .where(and(eq(expenseReport.tenantId, tenantA), eq(expenseReport.id, reportId)));
    const [finalLineItem] = await db
      .select()
      .from(lineItem)
      .where(and(eq(lineItem.tenant_id, tenantA), eq(lineItem.id, lineItemId)));
    const transitionRows = await db
      .select()
      .from(stageTransition)
      .where(
        and(eq(stageTransition.tenantId, tenantA), eq(stageTransition.expenseReportId, reportId))
      );
    const auditRows = await db
      .select()
      .from(auditEntry)
      .where(and(eq(auditEntry.tenantId, tenantA), eq(auditEntry.expenseReportId, reportId)));

    expect(finalReport?.currentStage).toBe("Drafted");
    expect(finalLineItem).toMatchObject({
      flagged: true,
      flag_cleared: true,
      gl_coding_status: "mapped",
      gl_account_code: "6100"
    });
    expect(transitionRows.map((row) => [row.fromStage, row.toStage])).toEqual([
      [null, "Drafted"],
      ["Drafted", "Submitted"],
      ["Submitted", "Manager Approval"],
      ["Manager Approval", "AP Review"],
      ["AP Review", "Drafted"]
    ]);
    expect(auditRows.map((row) => [row.action, row.result])).toEqual([
      ["Expense Report Created", "success"],
      ["Expense Report Submitted", "success"],
      ["Expense Report Transition Denied", "failure"],
      ["Expense Report Advanced", "success"],
      ["Expense Report Transition Denied", "failure"],
      ["Expense Report Advanced", "success"],
      ["Expense Report Send Back Denied", "failure"],
      ["Expense Report Sent Back", "success"]
    ]);
  });
});

async function ensureComputeGlSchema(client: pg.Client): Promise<void> {
  const tableExists = await client.query<{ exists: boolean }>(
    "select exists (select 1 from information_schema.tables where table_name = 'gl_mapping')"
  );
  if (tableExists.rows[0]?.exists === true) {
    return;
  }

  const migrationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../services/compute/db/migrations/0001_gl_coding_reference.sql"
  );
  await client.query(await readFile(migrationPath, "utf8"));
}

async function seedGlMappings(client: pg.Client, tenantId: string): Promise<void> {
  await client.query(
    `
    with upsert_codes as (
      insert into gl_code (
        tenant_id,
        account_code,
        account_name,
        normal_balance
      )
      values
        ($1::uuid, '6100', 'Synthetic Meals Expense', 'debit')
      on conflict (tenant_id, account_code) do update
      set
        account_name = excluded.account_name,
        normal_balance = excluded.normal_balance,
        active = true,
        updated_at = now()
      returning id, tenant_id
    )
    insert into gl_mapping (
      tenant_id,
      category,
      gl_code_id
    )
    select tenant_id, 'Meals', id
    from upsert_codes
    on conflict (tenant_id, category) do update
    set
      gl_code_id = excluded.gl_code_id,
      updated_at = now();
    `,
    [tenantId]
  );
}

async function startComputeServer(
  port: number,
  environment: Record<string, string>
): Promise<ChildProcessWithoutNullStreams> {
  const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const computeDirectory = join(rootDirectory, "services/compute");
  const child = spawn(
    "uv",
    ["run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: computeDirectory,
      env: {
        ...process.env,
        ...environment
      }
    }
  );
  child.stdout.on("data", () => undefined);

  await waitForComputeHealth(port, child);
  return child;
}

async function stopComputeServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitForComputeHealth(
  port: number,
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Compute service exited early: ${stderr}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await sleep(50);
    }
  }

  throw new Error(`Compute service did not become healthy: ${stderr}`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("Could not reserve a free port."));
        return;
      }

      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function bearerToken(tenantId: string, userId: string, roles: string[]): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles
  });

  return `Bearer ${tokenPair.accessToken}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for submit transition integration tests.");
  }

  return process.env.DATABASE_URI;
}
