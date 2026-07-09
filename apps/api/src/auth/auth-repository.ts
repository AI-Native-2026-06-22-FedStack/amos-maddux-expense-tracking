import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { db as defaultDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import {
  authAuditEntry,
  credential,
  mfaEnrollment,
  refreshToken,
  role,
  user
} from "../db/schema.js";
import type {
  AuthAuditEntrySelect,
  CredentialSelect,
  MfaEnrollmentSelect,
  RefreshTokenSelect,
  UserInsert,
  UserSelect
} from "../db/schema.js";

type AuthDatabase = NodePgDatabase<typeof schema>;

export interface CreateRegisteredUserInput {
  user: UserInsert;
  passwordHash: string;
  protectedTotpSecret: string;
  totpSecretKeyId: string;
}

export interface RegisteredUserRecord {
  user: UserSelect;
  credential: CredentialSelect;
  mfaEnrollment: MfaEnrollmentSelect;
}

export interface UserCredentialRecord {
  user: UserSelect;
  credential: CredentialSelect;
}

export interface AuthenticatedUserRoleRecord {
  user: UserSelect;
  roleName: string;
}

export interface CreateRefreshTokenInput {
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface CompleteMfaAuthenticationInput extends CreateRefreshTokenInput {
  acceptedTotpTimeStep: number;
}

export interface CreateAuthAuditEntryInput {
  tenantId: string;
  userId: string | null;
  eventType: string;
  outcome: "success" | "failure";
  reason: string | null;
}

export interface AuthRepository {
  createRegisteredUser(input: CreateRegisteredUserInput): Promise<RegisteredUserRecord>;
  findCredentialByEmail(tenantId: string, email: string): Promise<UserCredentialRecord | null>;
  findActiveMfaEnrollment(tenantId: string, userId: string): Promise<MfaEnrollmentSelect | null>;
  findAuthenticatedUserRole(
    tenantId: string,
    userId: string
  ): Promise<AuthenticatedUserRoleRecord | null>;
  createRefreshToken(input: CreateRefreshTokenInput): Promise<RefreshTokenSelect>;
  revokeRefreshToken(tenantId: string, tokenHash: string): Promise<void>;
  acceptTotpTimeStep(tenantId: string, userId: string, timeStep: number): Promise<boolean>;
  completeMfaAuthentication(input: CompleteMfaAuthenticationInput): Promise<boolean>;
  createAuthAuditEntry(input: CreateAuthAuditEntryInput): Promise<AuthAuditEntrySelect>;
}

class DrizzleAuthRepository implements AuthRepository {
  public constructor(private readonly db: AuthDatabase) {}

  public async createRegisteredUser(
    input: CreateRegisteredUserInput
  ): Promise<RegisteredUserRecord> {
    return this.db.transaction(async (tx) => {
      const [createdUser] = await tx.insert(user).values(input.user).returning();

      if (createdUser === undefined) {
        throw new Error("User registration failed.");
      }

      const [createdCredential] = await tx
        .insert(credential)
        .values({
          tenantId: createdUser.tenantId,
          userId: createdUser.id,
          passwordHash: input.passwordHash
        })
        .returning();

      if (createdCredential === undefined) {
        throw new Error("Credential creation failed.");
      }

      const [createdMfaEnrollment] = await tx
        .insert(mfaEnrollment)
        .values({
          tenantId: createdUser.tenantId,
          userId: createdUser.id,
          encryptedTotpSecret: input.protectedTotpSecret,
          totpSecretKeyId: input.totpSecretKeyId
        })
        .returning();

      if (createdMfaEnrollment === undefined) {
        throw new Error("MFA enrollment creation failed.");
      }

      return {
        user: createdUser,
        credential: createdCredential,
        mfaEnrollment: createdMfaEnrollment
      };
    });
  }

  public async createAuthAuditEntry(
    input: CreateAuthAuditEntryInput
  ): Promise<AuthAuditEntrySelect> {
    const [createdAuditEntry] = await this.db
      .insert(authAuditEntry)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        eventType: input.eventType,
        outcome: input.outcome,
        reason: input.reason
      })
      .returning();

    if (createdAuditEntry === undefined) {
      throw new Error("Auth audit entry creation failed.");
    }

    return createdAuditEntry;
  }

  public async findCredentialByEmail(
    tenantId: string,
    email: string
  ): Promise<UserCredentialRecord | null> {
    const [row] = await this.db
      .select({ user, credential })
      .from(user)
      .innerJoin(
        credential,
        and(eq(credential.tenantId, user.tenantId), eq(credential.userId, user.id))
      )
      .where(and(eq(user.tenantId, tenantId), eq(user.email, email), isNull(user.disabledAt)))
      .limit(1);

    return row ?? null;
  }

  public async findActiveMfaEnrollment(
    tenantId: string,
    userId: string
  ): Promise<MfaEnrollmentSelect | null> {
    const [enrollment] = await this.db
      .select()
      .from(mfaEnrollment)
      .where(
        and(
          eq(mfaEnrollment.tenantId, tenantId),
          eq(mfaEnrollment.userId, userId),
          isNull(mfaEnrollment.disabledAt)
        )
      )
      .limit(1);

    return enrollment ?? null;
  }

  public async findAuthenticatedUserRole(
    tenantId: string,
    userId: string
  ): Promise<AuthenticatedUserRoleRecord | null> {
    const [row] = await this.db
      .select({ user, roleName: role.name })
      .from(user)
      .innerJoin(role, and(eq(role.tenantId, user.tenantId), eq(role.id, user.roleId)))
      .where(and(eq(user.tenantId, tenantId), eq(user.id, userId), isNull(user.disabledAt)))
      .limit(1);

    return row ?? null;
  }

  public async createRefreshToken(input: CreateRefreshTokenInput): Promise<RefreshTokenSelect> {
    const [createdRefreshToken] = await this.db
      .insert(refreshToken)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt
      })
      .returning();

    if (createdRefreshToken === undefined) {
      throw new Error("Refresh token creation failed.");
    }

    return createdRefreshToken;
  }

  public async revokeRefreshToken(tenantId: string, tokenHash: string): Promise<void> {
    await this.db
      .update(refreshToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshToken.tenantId, tenantId), eq(refreshToken.tokenHash, tokenHash)));
  }

  public async acceptTotpTimeStep(
    tenantId: string,
    userId: string,
    timeStep: number
  ): Promise<boolean> {
    const acceptedAt = new Date();
    const acceptedRows = await this.db
      .update(mfaEnrollment)
      .set({
        lastAcceptedTotpTimeStep: timeStep,
        lastAcceptedTotpAt: acceptedAt
      })
      .where(
        and(
          eq(mfaEnrollment.tenantId, tenantId),
          eq(mfaEnrollment.userId, userId),
          isNull(mfaEnrollment.disabledAt),
          or(
            isNull(mfaEnrollment.lastAcceptedTotpTimeStep),
            lt(mfaEnrollment.lastAcceptedTotpTimeStep, timeStep)
          )
        )
      )
      .returning({ id: mfaEnrollment.id });

    return acceptedRows.length === 1;
  }

  public async completeMfaAuthentication(input: CompleteMfaAuthenticationInput): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const acceptedRows = await tx
        .update(mfaEnrollment)
        .set({
          lastAcceptedTotpTimeStep: input.acceptedTotpTimeStep,
          lastAcceptedTotpAt: new Date()
        })
        .where(
          and(
            eq(mfaEnrollment.tenantId, input.tenantId),
            eq(mfaEnrollment.userId, input.userId),
            isNull(mfaEnrollment.disabledAt),
            or(
              isNull(mfaEnrollment.lastAcceptedTotpTimeStep),
              lt(mfaEnrollment.lastAcceptedTotpTimeStep, input.acceptedTotpTimeStep)
            )
          )
        )
        .returning({ id: mfaEnrollment.id });

      if (acceptedRows.length !== 1) {
        return false;
      }

      await tx.insert(refreshToken).values({
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt
      });
      await tx.insert(authAuditEntry).values({
        tenantId: input.tenantId,
        userId: input.userId,
        eventType: "mfa_succeeded",
        outcome: "success",
        reason: null
      });

      return true;
    });
  }
}

export function createAuthRepository(db: AuthDatabase = defaultDb): AuthRepository {
  return new DrizzleAuthRepository(db);
}
