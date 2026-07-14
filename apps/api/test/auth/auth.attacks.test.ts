import { generateKeyPairSync } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import jwt from "jsonwebtoken";
import pg from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthRepository } from "../../src/auth/auth-repository.js";
import { TotpSecretProtector, createAuthService } from "../../src/auth/auth-service.js";
import { generateTotpCode } from "../../src/auth/mfa.js";
import { hashRefreshToken, issueTokenPair, loadJwtRuntimeConfig } from "../../src/auth/tokens.js";
import * as schema from "../../src/db/schema.js";
import { authAuditEntry, expenseReport, refreshToken, role } from "../../src/db/schema.js";

const { Client } = pg;

const tenantA = "00000000-0000-4000-8000-000000000801";
const tenantB = "00000000-0000-4000-8000-000000000802";
const elevatedTenant = "00000000-0000-4000-8000-000000000803";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000804";
const clientSuppliedUserId = "synthetic-user-00000000-0000-4000-8000-000000000805";
const syntheticEmail = "synthetic.attack.employee@example.test";
const unknownSyntheticEmail = "missing.attack.employee@example.test";
const syntheticPassword = "synthetic-attack-passphrase";
const wrongSyntheticPassword = "synthetic-attack-wrong-passphrase";

let client: pg.Client;

describe("authentication attack regression suite", () => {
  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("allows a valid RS256 bearer token to reach the protected Expense Report creation endpoint", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId }))
      .send({
        tenantId: tenantB,
        submitterId: clientSuppliedUserId
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      tenantId: tenantA,
      submitterId: userId,
      currentStage: "Drafted"
    });
  });

  it("rejects a missing bearer token before creating an Expense Report", async () => {
    const response = await request(createApp()).post("/v1/expense-reports").send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(elevatedTenant, 0);
  });

  it("rejects a malformed bearer token before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", "Bearer synthetic-malformed-token")
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(elevatedTenant, 0);
  });

  it("rejects an expired RS256 token before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createExpiredBearerToken())
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(tenantA, 0);
  });

  it("rejects a wrong-issuer token before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ issuer: "synthetic-wrong-issuer" }))
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(tenantA, 0);
  });

  it("rejects a wrong-audience token before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ audience: "synthetic-wrong-audience" }))
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(tenantA, 0);
  });

  it("rejects a forged alg=none token with elevated privileges before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createNoneAlgorithmBearerToken())
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(elevatedTenant, 0);
  });

  it("rejects a wrong-key RS256 token before creating an Expense Report", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createWrongKeyBearerToken())
      .send({});

    expect(response.status).toBe(401);
    await expectExpenseReportCount(elevatedTenant, 0);
  });

  it("preserves tenant isolation by ignoring client-supplied tenant identifiers after authentication", async () => {
    const response = await request(createApp())
      .post("/v1/expense-reports")
      .set("Authorization", createBearerToken({ tenantId: tenantA, userId }))
      .send({
        tenantId: tenantB,
        submitterId: clientSuppliedUserId
      });

    expect(response.status).toBe(201);
    await expectExpenseReportCount(tenantA, 1);
    await expectExpenseReportCount(tenantB, 0);
  });

  it("returns the same generic response for unknown user and wrong password attempts", async () => {
    const { service } = createServiceContext();
    const roleId = await createTenantRole();

    await service.register({
      tenantId: tenantA,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic Attack Employee",
      password: syntheticPassword
    });

    const unknownUserResult = await service.startLogin({
      tenantId: tenantA,
      email: unknownSyntheticEmail,
      password: syntheticPassword
    });
    const wrongPasswordResult = await service.startLogin({
      tenantId: tenantA,
      email: syntheticEmail,
      password: wrongSyntheticPassword
    });

    expect(unknownUserResult).toEqual(wrongPasswordResult);
    expect("accessToken" in unknownUserResult).toBe(false);
    expect("accessToken" in wrongPasswordResult).toBe(false);
    await expect(findAuthAuditEvents(tenantA)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "login_failed_unknown_user",
          outcome: "failure",
          reason: "unknown_user",
          userId: null
        }),
        expect.objectContaining({
          eventType: "login_failed_wrong_password",
          outcome: "failure",
          reason: "wrong_password",
          userId: expect.any(String)
        })
      ])
    );
  });

  it("rejects a wrong TOTP code and issues no token", async () => {
    const { service } = createServiceContext();
    const roleId = await createTenantRole();
    const registered = await service.register({
      tenantId: tenantA,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic Attack Employee",
      password: syntheticPassword
    });

    const validCode = await generateTotpCode(registered.mfa.secret);
    const invalidCode = validCode === "000000" ? "000001" : "000000";
    const result = await service.completeMfaLogin({
      tenantId: tenantA,
      userId: registered.userId,
      code: invalidCode
    });

    expect(result).toEqual({
      status: "unauthorized",
      message: "Invalid MFA code."
    });
    expect("accessToken" in result).toBe(false);
    await expectRefreshTokenCount(tenantA, registered.userId, 0);
    await expect(findAuthAuditEvents(tenantA)).resolves.toContainEqual({
      eventType: "mfa_failed_wrong_totp",
      outcome: "failure",
      reason: "wrong_totp",
      userId: registered.userId
    });
  });

  it("issues tokens after valid password and TOTP and persists only the refresh token hash", async () => {
    const { service } = createServiceContext();
    const roleId = await createTenantRole();
    const registered = await service.register({
      tenantId: tenantA,
      roleId,
      email: syntheticEmail,
      displayName: "Synthetic Attack Employee",
      password: syntheticPassword
    });
    const passwordResult = await service.startLogin({
      tenantId: tenantA,
      email: syntheticEmail,
      password: syntheticPassword
    });
    const code = await generateTotpCode(registered.mfa.secret);
    const result = await service.completeMfaLogin({
      tenantId: tenantA,
      userId: registered.userId,
      code
    });

    expect(passwordResult).toMatchObject({ status: "mfa_required" });
    expect(result).toMatchObject({
      status: "authenticated",
      tenantId: tenantA,
      userId: registered.userId,
      roles: ["Employee"],
      accessToken: expect.any(String),
      refreshToken: expect.any(String)
    });

    if (result.status !== "authenticated") {
      throw new Error("Synthetic successful authentication setup failed.");
    }

    const storedRefreshToken = await findRefreshToken(tenantA, result.refreshToken);
    expect(storedRefreshToken.userId).toBe(registered.userId);
    expect(storedRefreshToken.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(storedRefreshToken.tokenHash).not.toBe(result.refreshToken);
  });
});

function createServiceContext(): {
  service: ReturnType<typeof createAuthService>;
} {
  const db = drizzle(client, { schema });
  const repository = createAuthRepository(db);
  const service = createAuthService(repository, new SyntheticNoOpTotpSecretProtector());

  return { service };
}

async function createTenantRole(): Promise<string> {
  const db = drizzle(client, { schema });
  const [createdRole] = await db
    .insert(role)
    .values({
      tenantId: tenantA,
      name: "Employee"
    })
    .returning();

  if (createdRole === undefined) {
    throw new Error("Synthetic role setup failed.");
  }

  return createdRole.id;
}

async function expectExpenseReportCount(tenantId: string, expectedCount: number): Promise<void> {
  const db = drizzle(client, { schema });
  const rows = await db.select().from(expenseReport).where(eq(expenseReport.tenantId, tenantId));

  expect(rows).toHaveLength(expectedCount);
}

async function expectRefreshTokenCount(
  tenantId: string,
  refreshTokenUserId: string,
  expectedCount: number
): Promise<void> {
  const db = drizzle(client, { schema });
  const rows = await db
    .select()
    .from(refreshToken)
    .where(and(eq(refreshToken.tenantId, tenantId), eq(refreshToken.userId, refreshTokenUserId)));

  expect(rows).toHaveLength(expectedCount);
}

async function findAuthAuditEvents(tenantId: string): Promise<
  Array<{
    eventType: string;
    outcome: string;
    reason: string | null;
    userId: string | null;
  }>
> {
  const db = drizzle(client, { schema });
  const rows = await db
    .select({
      eventType: authAuditEntry.eventType,
      outcome: authAuditEntry.outcome,
      reason: authAuditEntry.reason,
      userId: authAuditEntry.userId
    })
    .from(authAuditEntry)
    .where(eq(authAuditEntry.tenantId, tenantId));

  return rows;
}

async function findRefreshToken(
  tenantId: string,
  rawRefreshToken: string
): Promise<typeof refreshToken.$inferSelect> {
  const db = drizzle(client, { schema });
  const [storedRefreshToken] = await db
    .select()
    .from(refreshToken)
    .where(
      and(
        eq(refreshToken.tenantId, tenantId),
        eq(refreshToken.tokenHash, hashRefreshToken(rawRefreshToken))
      )
    )
    .limit(1);

  if (storedRefreshToken === undefined) {
    throw new Error("Synthetic refresh token setup failed.");
  }

  return storedRefreshToken;
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
      userId: overrides.userId ?? userId,
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
      subject: overrides.userId ?? userId
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
      subject: userId
    }
  );

  return `Bearer ${accessToken}`;
}

function createNoneAlgorithmBearerToken(): string {
  const config = loadJwtRuntimeConfig();
  const forgedToken = jwt.sign(
    {
      tenantId: elevatedTenant,
      roles: ["ExpenseFlow Platform Admin"]
    },
    "",
    {
      algorithm: "none",
      issuer: config.issuer,
      audience: config.audience,
      subject: userId
    }
  );

  return `Bearer ${forgedToken}`;
}

function createWrongKeyBearerToken(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    }
  });
  const config = loadJwtRuntimeConfig();
  const forgedToken = jwt.sign(
    {
      tenantId: elevatedTenant,
      roles: ["ExpenseFlow Platform Admin"]
    },
    privateKey,
    {
      algorithm: "RS256",
      keyid: config.keyId,
      issuer: config.issuer,
      audience: config.audience,
      subject: userId
    }
  );

  return `Bearer ${forgedToken}`;
}

class SyntheticNoOpTotpSecretProtector implements TotpSecretProtector {
  public protect(secret: string): Promise<string> {
    return Promise.resolve(secret);
  }

  public reveal(protectedSecret: string): Promise<string> {
    return Promise.resolve(protectedSecret);
  }

  public keyId(): string {
    return "synthetic-no-op-totp-secret-protector";
  }
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for authentication attack tests.");
  }

  return process.env.DATABASE_URI;
}
