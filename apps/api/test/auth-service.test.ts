import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createAuthRepository } from "../src/auth/auth-repository.js";
import { TokenIssuer, TotpSecretProtector, createAuthService } from "../src/auth/auth-service.js";
import { verifyPasswordHash } from "../src/auth/hashing.js";
import { generateTotpCode } from "../src/auth/mfa.js";
import { hashRefreshToken } from "../src/auth/tokens.js";
import * as schema from "../src/db/schema.js";
import { authAuditEntry, credential, mfaEnrollment, refreshToken, role } from "../src/db/schema.js";

const { Client } = pg;

const tenantId = "00000000-0000-4000-8000-000000000501";
const syntheticEmail = "synthetic.employee@example.test";
const unknownSyntheticEmail = "missing.employee@example.test";
const syntheticPassword = "synthetic-registration-passphrase";
const wrongSyntheticPassword = "synthetic-wrong-passphrase";
const syntheticDisplayName = "Synthetic Employee";

describe("AuthService integration", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new Client({ connectionString: getDatabaseUrl() });
    await client.connect();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await client.end();
  });

  it("stores an argon2id password hash that differs from the plaintext password", async () => {
    const { db, service } = createServiceContext(client);
    const roleId = await createTenantRole(db);

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });

    const storedCredential = await findCredential(db, registered.userId);
    const auditEvents = await findAuthAuditEvents(db);

    expect(storedCredential.passwordHash).not.toBe(syntheticPassword);
    expect(storedCredential.passwordHash).toContain("$argon2id$");
    expect(auditEvents).toContainEqual({
      eventType: "registration_succeeded",
      outcome: "success",
      reason: null,
      userId: registered.userId
    });
  });

  it("stores an argon2id hash that verifies with the correct password", async () => {
    const { db, service } = createServiceContext(client);
    const roleId = await createTenantRole(db);

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const storedCredential = await findCredential(db, registered.userId);

    await expect(
      verifyPasswordHash(storedCredential.passwordHash, syntheticPassword)
    ).resolves.toBe(true);
  });

  it("returns the same generic unauthorized result for a wrong password and unknown user", async () => {
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(drizzle(client, { schema }));

    await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });

    const wrongPasswordResult = await service.startLogin({
      tenantId,
      email: syntheticEmail,
      password: wrongSyntheticPassword
    });
    const unknownUserResult = await service.startLogin({
      tenantId,
      email: unknownSyntheticEmail,
      password: syntheticPassword
    });
    const auditEvents = await findAuthAuditEvents(drizzle(client, { schema }));

    expect(wrongPasswordResult).toEqual(unknownUserResult);
    expect(auditEvents).toContainEqual({
      eventType: "login_failed_wrong_password",
      outcome: "failure",
      reason: "wrong_password",
      userId: expect.any(String)
    });
    expect(auditEvents).toContainEqual({
      eventType: "login_failed_unknown_user",
      outcome: "failure",
      reason: "unknown_user",
      userId: null
    });
  });

  it("requires MFA after a correct password and does not issue a token", async () => {
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(drizzle(client, { schema }));

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });

    const loginResult = await service.startLogin({
      tenantId,
      email: syntheticEmail,
      password: syntheticPassword
    });
    const auditEvents = await findAuthAuditEvents(drizzle(client, { schema }));

    expect(loginResult).toEqual({
      status: "mfa_required",
      tenantId,
      userId: registered.userId,
      message: "MFA required."
    });
    expect("accessToken" in loginResult).toBe(false);
    expect(auditEvents).toContainEqual({
      eventType: "password_verified_mfa_required",
      outcome: "success",
      reason: null,
      userId: registered.userId
    });
  });

  it("completes authentication with a valid TOTP code and persists a refresh token hash", async () => {
    const db = drizzle(client, { schema });
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(db);

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const code = await generateTotpCode(registered.mfa.secret);

    const result = await service.completeMfaLogin({
      tenantId,
      userId: registered.userId,
      code
    });

    expect(result).toEqual({
      status: "authenticated",
      tenantId,
      userId: registered.userId,
      roles: ["Employee"],
      accessToken: expect.any(String),
      refreshToken: expect.any(String)
    });

    if (result.status !== "authenticated") {
      throw new Error("Synthetic authentication setup failed.");
    }

    const storedRefreshToken = await findRefreshToken(db, result.refreshToken);
    const storedMfaEnrollment = await findMfaEnrollment(db, registered.userId);
    const auditEvents = await findAuthAuditEvents(db);

    expect(storedRefreshToken.userId).toBe(registered.userId);
    expect(storedRefreshToken.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(storedRefreshToken.tokenHash).not.toBe(result.refreshToken);
    expect(storedMfaEnrollment.lastAcceptedTotpTimeStep).toEqual(expect.any(Number));
    expect(storedMfaEnrollment.lastAcceptedTotpAt).toBeInstanceOf(Date);
    expect(auditEvents).toContainEqual({
      eventType: "mfa_succeeded",
      outcome: "success",
      reason: null,
      userId: registered.userId
    });
  });

  it("rotates a valid refresh token and rejects reuse of the old token", async () => {
    const db = drizzle(client, { schema });
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(db);
    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const code = await generateTotpCode(registered.mfa.secret);
    const loginResult = await service.completeMfaLogin({
      tenantId,
      userId: registered.userId,
      code
    });

    if (loginResult.status !== "authenticated") {
      throw new Error("Synthetic authentication setup failed.");
    }

    const refreshResult = await service.refreshSession({
      tenantId,
      userId: registered.userId,
      refreshToken: loginResult.refreshToken
    });
    const reusedRefreshResult = await service.refreshSession({
      tenantId,
      userId: registered.userId,
      refreshToken: loginResult.refreshToken
    });

    expect(refreshResult).toMatchObject({
      status: "authenticated",
      tenantId,
      userId: registered.userId,
      roles: ["Employee"],
      accessToken: expect.any(String),
      refreshToken: expect.any(String)
    });
    expect(reusedRefreshResult).toEqual({
      status: "unauthorized",
      message: "Invalid refresh token."
    });

    if (refreshResult.status !== "authenticated") {
      throw new Error("Synthetic refresh setup failed.");
    }

    const oldStoredRefreshToken = await findRefreshToken(db, loginResult.refreshToken);
    const newStoredRefreshToken = await findRefreshToken(db, refreshResult.refreshToken);
    const auditEvents = await findAuthAuditEvents(db);

    expect(oldStoredRefreshToken.revokedAt).toBeInstanceOf(Date);
    expect(newStoredRefreshToken.revokedAt).toBeNull();
    expect(auditEvents).toContainEqual({
      eventType: "refresh_succeeded",
      outcome: "success",
      reason: null,
      userId: registered.userId
    });
    expect(auditEvents).toContainEqual({
      eventType: "refresh_failed",
      outcome: "failure",
      reason: "invalid_refresh_token",
      userId: registered.userId
    });
  });

  it("rejects an invalid TOTP code and does not issue a token", async () => {
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(drizzle(client, { schema }));

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const validCode = await generateTotpCode(registered.mfa.secret);
    const invalidCode = validCode === "000000" ? "000001" : "000000";

    const result = await service.completeMfaLogin({
      tenantId,
      userId: registered.userId,
      code: invalidCode
    });

    expect(result).toEqual({
      status: "unauthorized",
      message: "Invalid MFA code."
    });
    expect("accessToken" in result).toBe(false);

    await expect(findAuthAuditEvents(drizzle(client, { schema }))).resolves.toContainEqual({
      eventType: "mfa_failed_wrong_totp",
      outcome: "failure",
      reason: "wrong_totp",
      userId: registered.userId
    });
  });

  it("rejects a replayed TOTP code and writes a safe audit entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));

    const db = drizzle(client, { schema });
    const { service } = createServiceContext(client);
    const roleId = await createTenantRole(db);

    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const code = await generateTotpCode(registered.mfa.secret);
    const firstResult = await service.completeMfaLogin({
      tenantId,
      userId: registered.userId,
      code
    });
    const replayResult = await service.completeMfaLogin({
      tenantId,
      userId: registered.userId,
      code
    });

    expect(firstResult).toMatchObject({ status: "authenticated" });
    expect(replayResult).toEqual({
      status: "unauthorized",
      message: "Invalid MFA code."
    });
    expect("accessToken" in replayResult).toBe(false);
    await expect(findRefreshTokenCount(db, registered.userId)).resolves.toBe(1);
    await expect(findAuthAuditEvents(db)).resolves.toContainEqual({
      eventType: "mfa_failed_replay",
      outcome: "failure",
      reason: "totp_replay",
      userId: registered.userId
    });
  });

  it("does not consume a TOTP time step when a later MFA completion step fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));

    const db = drizzle(client, { schema });
    const repository = createAuthRepository(db);
    const service = createAuthService(
      repository,
      new SyntheticNoOpTotpSecretProtector(),
      new ThrowingTokenIssuer()
    );
    const roleId = await createTenantRole(db);
    const registered = await service.register({
      tenantId,
      roleId,
      email: syntheticEmail,
      displayName: syntheticDisplayName,
      password: syntheticPassword
    });
    const code = await generateTotpCode(registered.mfa.secret);

    await expect(
      service.completeMfaLogin({
        tenantId,
        userId: registered.userId,
        code
      })
    ).rejects.toThrow("Synthetic token issuer failure.");

    const storedMfaEnrollment = await findMfaEnrollment(db, registered.userId);
    expect(storedMfaEnrollment.lastAcceptedTotpTimeStep).toBeNull();
    expect(storedMfaEnrollment.lastAcceptedTotpAt).toBeNull();
    await expect(findRefreshTokenCount(db, registered.userId)).resolves.toBe(0);
  });
});

type TestDatabase = NodePgDatabase<typeof schema>;

function createServiceContext(client: pg.Client): {
  db: TestDatabase;
  service: ReturnType<typeof createAuthService>;
} {
  const db = drizzle(client, { schema });
  const repository = createAuthRepository(db);
  const service = createAuthService(repository, new SyntheticNoOpTotpSecretProtector());

  return { db, service };
}

async function createTenantRole(db: TestDatabase): Promise<string> {
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

async function findCredential(
  db: TestDatabase,
  userId: string
): Promise<typeof credential.$inferSelect> {
  const [storedCredential] = await db
    .select()
    .from(credential)
    .where(and(eq(credential.tenantId, tenantId), eq(credential.userId, userId)))
    .limit(1);

  if (storedCredential === undefined) {
    throw new Error("Synthetic credential setup failed.");
  }

  return storedCredential;
}

async function findRefreshToken(
  db: TestDatabase,
  rawRefreshToken: string
): Promise<typeof refreshToken.$inferSelect> {
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

async function findRefreshTokenCount(db: TestDatabase, userId: string): Promise<number> {
  const rows = await db
    .select()
    .from(refreshToken)
    .where(and(eq(refreshToken.tenantId, tenantId), eq(refreshToken.userId, userId)));

  return rows.length;
}

async function findMfaEnrollment(
  db: TestDatabase,
  userId: string
): Promise<typeof mfaEnrollment.$inferSelect> {
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

async function findAuthAuditEvents(db: TestDatabase): Promise<
  Array<{
    eventType: string;
    outcome: string;
    reason: string | null;
    userId: string | null;
  }>
> {
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

class ThrowingTokenIssuer implements TokenIssuer {
  public issue(): never {
    throw new Error("Synthetic token issuer failure.");
  }
}

function getDatabaseUrl(): string {
  if (process.env.DATABASE_URI === undefined) {
    throw new Error("DATABASE_URI is required for Auth Service integration tests.");
  }

  return process.env.DATABASE_URI;
}
