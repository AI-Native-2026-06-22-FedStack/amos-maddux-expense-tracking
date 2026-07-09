import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import request from "supertest";

import { createApp } from "../src/app.js";
import { generateTotpCode } from "../src/auth/mfa.js";
import * as schema from "../src/db/schema.js";
import { mfaEnrollment, role } from "../src/db/schema.js";

const { Client } = pg;

const tenantId = "00000000-0000-4000-8000-000000000901";
const syntheticEmail = "synthetic.http.employee@example.test";
const unknownSyntheticEmail = "missing.http.employee@example.test";
const syntheticPassword = "synthetic-http-passphrase";
const wrongSyntheticPassword = "synthetic-http-wrong-passphrase";

let client: pg.Client;

describe("Auth HTTP routes", () => {
  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("registers, requires MFA after password login, and completes MFA through HTTP", async () => {
    const app = createApp();
    const roleId = await createTenantRole();
    const registerResponse = await request(app).post("/auth/register").send({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic HTTP Employee",
      password: syntheticPassword
    });

    expect(registerResponse.status).toBe(201);
    expect(registerResponse.body).toMatchObject({
      tenantId,
      email: syntheticEmail,
      userId: expect.any(String),
      mfa: {
        secret: expect.any(String),
        provisioningUri: expect.any(String)
      }
    });

    const storedMfaEnrollment = await findMfaEnrollment(registerResponse.body.userId as string);
    expect(storedMfaEnrollment.encryptedTotpSecret).not.toBe(
      registerResponse.body.mfa.secret as string
    );

    const loginResponse = await request(app).post("/auth/login").send({
      tenantId,
      email: syntheticEmail,
      password: syntheticPassword
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body).toEqual({
      status: "mfa_required",
      tenantId,
      userId: registerResponse.body.userId,
      message: "MFA required."
    });
    expect(loginResponse.body).not.toHaveProperty("accessToken");

    const code = await generateTotpCode(registerResponse.body.mfa.secret as string);
    const mfaResponse = await request(app).post("/auth/mfa").send({
      tenantId,
      userId: registerResponse.body.userId,
      code
    });

    expect(mfaResponse.status).toBe(200);
    expect(mfaResponse.body).toMatchObject({
      status: "authenticated",
      tenantId,
      userId: registerResponse.body.userId,
      roles: ["Employee"],
      accessToken: expect.any(String),
      refreshToken: expect.any(String)
    });
  });

  it("returns the same generic HTTP failure for unknown user and wrong password", async () => {
    const app = createApp();
    const roleId = await createTenantRole();

    await request(app).post("/auth/register").send({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic HTTP Employee",
      password: syntheticPassword
    });

    const unknownUserResponse = await request(app).post("/auth/login").send({
      tenantId,
      email: unknownSyntheticEmail,
      password: syntheticPassword
    });
    const wrongPasswordResponse = await request(app).post("/auth/login").send({
      tenantId,
      email: syntheticEmail,
      password: wrongSyntheticPassword
    });

    expect(unknownUserResponse.status).toBe(401);
    expect(wrongPasswordResponse.status).toBe(401);
    expect(unknownUserResponse.body).toEqual(wrongPasswordResponse.body);
    expect(unknownUserResponse.body.detail).toBe("Invalid email or password.");
    expect(unknownUserResponse.body).not.toHaveProperty("accessToken");
  });

  it("rejects invalid MFA through HTTP without issuing a token", async () => {
    const app = createApp();
    const roleId = await createTenantRole();
    const registerResponse = await request(app).post("/auth/register").send({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic HTTP Employee",
      password: syntheticPassword
    });
    const validCode = await generateTotpCode(registerResponse.body.mfa.secret as string);
    const invalidCode = validCode === "000000" ? "000001" : "000000";

    const mfaResponse = await request(app).post("/auth/mfa").send({
      tenantId,
      userId: registerResponse.body.userId,
      code: invalidCode
    });

    expect(mfaResponse.status).toBe(401);
    expect(mfaResponse.body).toMatchObject({
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid MFA code."
    });
    expect(mfaResponse.body).not.toHaveProperty("accessToken");
  });
});

async function createTenantRole(): Promise<string> {
  const db = drizzle(client, { schema });
  const [createdRole] = await db
    .insert(role)
    .values({
      tenantId,
      name: "Employee"
    })
    .returning();

  if (createdRole === undefined) {
    throw new Error("Synthetic role setup failed.");
  }

  return createdRole.id;
}

async function findMfaEnrollment(userId: string): Promise<typeof mfaEnrollment.$inferSelect> {
  const db = drizzle(client, { schema });
  const [storedMfaEnrollment] = await db
    .select()
    .from(mfaEnrollment)
    .where(and(eq(mfaEnrollment.tenantId, tenantId), eq(mfaEnrollment.userId, userId)))
    .limit(1);

  if (storedMfaEnrollment === undefined) {
    throw new Error("Synthetic MFA enrollment setup failed.");
  }

  return storedMfaEnrollment;
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Auth HTTP tests.");
  }

  return process.env.DATABASE_URL;
}
