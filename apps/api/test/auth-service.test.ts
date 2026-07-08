import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { createAuthRepository } from "../src/auth/auth-repository.js";
import { TotpSecretProtector, createAuthService } from "../src/auth/auth-service.js";
import { verifyPasswordHash } from "../src/auth/hashing.js";
import { generateTotpCode } from "../src/auth/mfa.js";
import { hashRefreshToken } from "../src/auth/tokens.js";
import * as schema from "../src/db/schema.js";
import { credential, refreshToken, role } from "../src/db/schema.js";

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

    expect(storedCredential.passwordHash).not.toBe(syntheticPassword);
    expect(storedCredential.passwordHash).toContain("$argon2id$");
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

    expect(wrongPasswordResult).toEqual(unknownUserResult);
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

    expect(loginResult).toEqual({
      status: "mfa_required",
      tenantId,
      userId: registered.userId,
      message: "MFA required."
    });
    expect("accessToken" in loginResult).toBe(false);
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
    expect(storedRefreshToken.userId).toBe(registered.userId);
    expect(storedRefreshToken.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(storedRefreshToken.tokenHash).not.toBe(result.refreshToken);
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
  if (process.env.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required for Auth Service integration tests.");
  }

  return process.env.DATABASE_URL;
}
