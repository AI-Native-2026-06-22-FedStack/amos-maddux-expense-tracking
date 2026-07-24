import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { AuthRepository, createAuthRepository } from "./auth-repository.js";
import { hashPassword, verifyPasswordHash } from "./hashing.js";
import { createTotpEnrollment, getCurrentTotpTimeStep, verifyTotpCode } from "./mfa.js";
import { AuthenticatedPrincipal, IssuedTokenPair, issueTokenPair } from "./tokens.js";

export const genericUnauthorizedMessage = "Invalid email or password.";

const localTotpSecretKeyId = "local-development-totp-secret-key";
const encryptedTotpSecretPrefix = "v1";

let generatedLocalTotpKey: Buffer | undefined;

const authAuditEvents = {
  registrationSucceeded: "registration_succeeded",
  passwordVerifiedMfaRequired: "password_verified_mfa_required",
  loginFailedUnknownUser: "login_failed_unknown_user",
  loginFailedWrongPassword: "login_failed_wrong_password",
  mfaFailedWrongTotp: "mfa_failed_wrong_totp",
  mfaFailedReplay: "mfa_failed_replay",
  mfaFailedMissingEnrollment: "mfa_failed_missing_enrollment",
  mfaFailedUserLookup: "mfa_failed_user_lookup"
} as const;

export interface TotpSecretProtector {
  protect(secret: string): Promise<string>;
  reveal(protectedSecret: string): Promise<string>;
  keyId(): string;
}

export interface TokenIssuer {
  issue(principal: AuthenticatedPrincipal): IssuedTokenPair;
}

export interface RegisterRequest {
  tenantId: string;
  roleId: string;
  email: string;
  displayName: string;
  password: string;
}

export interface RegisterResult {
  tenantId: string;
  userId: string;
  email: string;
  mfa: {
    secret: string;
    provisioningUri: string;
  };
}

export interface StartLoginRequest {
  tenantId: string;
  email: string;
  password: string;
}

export type StartLoginResult =
  | {
      status: "unauthorized";
      message: typeof genericUnauthorizedMessage;
    }
  | {
      status: "mfa_required";
      tenantId: string;
      userId: string;
      message: "MFA required.";
    };

export interface CompleteMfaLoginRequest {
  tenantId: string;
  userId: string;
  code: string;
}

export type CompleteMfaLoginResult =
  | {
      status: "unauthorized";
      message: "Invalid MFA code.";
    }
  | {
      status: "authenticated";
      tenantId: string;
      userId: string;
      roles: string[];
      accessToken: string;
      refreshToken: string;
    };

export interface AuthService {
  register(request: RegisterRequest): Promise<RegisterResult>;
  startLogin(request: StartLoginRequest): Promise<StartLoginResult>;
  completeMfaLogin(request: CompleteMfaLoginRequest): Promise<CompleteMfaLoginResult>;
}

class RepositoryAuthService implements AuthService {
  public constructor(
    private readonly authRepository: AuthRepository,
    private readonly totpSecretProtector: TotpSecretProtector,
    private readonly tokenIssuer: TokenIssuer
  ) {}

  public async register(request: RegisterRequest): Promise<RegisterResult> {
    const passwordHash = await hashPassword(request.password);
    const enrollment = createTotpEnrollment({
      accountName: request.email
    });
    const protectedTotpSecret = await this.totpSecretProtector.protect(enrollment.secret);
    const registered = await this.authRepository.createRegisteredUser({
      user: {
        tenantId: request.tenantId,
        roleId: request.roleId,
        email: request.email,
        displayName: request.displayName
      },
      passwordHash,
      protectedTotpSecret,
      totpSecretKeyId: this.totpSecretProtector.keyId()
    });
    await this.auditSuccess({
      tenantId: registered.user.tenantId,
      userId: registered.user.id,
      eventType: authAuditEvents.registrationSucceeded
    });

    return {
      tenantId: registered.user.tenantId,
      userId: registered.user.id,
      email: registered.user.email,
      mfa: {
        secret: enrollment.secret,
        provisioningUri: enrollment.provisioningUri
      }
    };
  }

  public async startLogin(request: StartLoginRequest): Promise<StartLoginResult> {
    const record = await this.authRepository.findCredentialByEmail(request.tenantId, request.email);

    if (record === null) {
      await this.auditFailure({
        tenantId: request.tenantId,
        userId: null,
        eventType: authAuditEvents.loginFailedUnknownUser,
        reason: "unknown_user"
      });
      return unauthorizedLoginResult();
    }

    const passwordMatches = await verifyPasswordHash(
      record.credential.passwordHash,
      request.password
    );

    if (!passwordMatches) {
      await this.auditFailure({
        tenantId: record.user.tenantId,
        userId: record.user.id,
        eventType: authAuditEvents.loginFailedWrongPassword,
        reason: "wrong_password"
      });
      return unauthorizedLoginResult();
    }

    await this.auditSuccess({
      tenantId: record.user.tenantId,
      userId: record.user.id,
      eventType: authAuditEvents.passwordVerifiedMfaRequired
    });

    return {
      status: "mfa_required",
      tenantId: record.user.tenantId,
      userId: record.user.id,
      message: "MFA required."
    };
  }

  public async completeMfaLogin(request: CompleteMfaLoginRequest): Promise<CompleteMfaLoginResult> {
    const enrollment = await this.authRepository.findActiveMfaEnrollment(
      request.tenantId,
      request.userId
    );

    if (enrollment === null) {
      await this.auditFailure({
        tenantId: request.tenantId,
        userId: request.userId,
        eventType: authAuditEvents.mfaFailedMissingEnrollment,
        reason: "missing_mfa_enrollment"
      });
      return invalidMfaResult();
    }

    const secret = await this.totpSecretProtector.reveal(enrollment.encryptedTotpSecret);
    const currentTotpTimeStep = getCurrentTotpTimeStep();
    const validNotReplayedCode = await verifyTotpCode({
      secret,
      code: request.code,
      afterTimeStep: enrollment.lastAcceptedTotpTimeStep
    });

    if (!validNotReplayedCode) {
      const validCurrentCode = await verifyTotpCode({ secret, code: request.code });

      if (
        validCurrentCode &&
        enrollment.lastAcceptedTotpTimeStep !== null &&
        enrollment.lastAcceptedTotpTimeStep >= currentTotpTimeStep
      ) {
        await this.auditFailure({
          tenantId: request.tenantId,
          userId: request.userId,
          eventType: authAuditEvents.mfaFailedReplay,
          reason: "totp_replay"
        });
        return invalidMfaResult();
      }

      await this.auditFailure({
        tenantId: request.tenantId,
        userId: request.userId,
        eventType: authAuditEvents.mfaFailedWrongTotp,
        reason: "wrong_totp"
      });
      return invalidMfaResult();
    }

    const authenticatedUser = await this.authRepository.findAuthenticatedUserRole(
      request.tenantId,
      request.userId
    );

    if (authenticatedUser === null) {
      await this.auditFailure({
        tenantId: request.tenantId,
        userId: request.userId,
        eventType: authAuditEvents.mfaFailedUserLookup,
        reason: "user_lookup_failed"
      });
      return invalidMfaResult();
    }

    const roles = [authenticatedUser.roleName];
    const tokenPair = this.tokenIssuer.issue({
      userId: authenticatedUser.user.id,
      tenantId: authenticatedUser.user.tenantId,
      roles
    });

    const completedAuthentication = await this.authRepository.completeMfaAuthentication({
      tenantId: authenticatedUser.user.tenantId,
      userId: authenticatedUser.user.id,
      tokenHash: tokenPair.refreshTokenHash,
      expiresAt: tokenPair.refreshTokenExpiresAt,
      acceptedTotpTimeStep: currentTotpTimeStep
    });

    if (!completedAuthentication) {
      await this.auditFailure({
        tenantId: request.tenantId,
        userId: request.userId,
        eventType: authAuditEvents.mfaFailedReplay,
        reason: "totp_replay"
      });
      return invalidMfaResult();
    }

    return {
      status: "authenticated",
      tenantId: authenticatedUser.user.tenantId,
      userId: authenticatedUser.user.id,
      roles,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken
    };
  }

  private async auditSuccess(input: {
    tenantId: string;
    userId: string;
    eventType: string;
  }): Promise<void> {
    await this.authRepository.createAuthAuditEntry({
      ...input,
      outcome: "success",
      reason: null
    });
  }

  private async auditFailure(input: {
    tenantId: string;
    userId: string | null;
    eventType: string;
    reason: string;
  }): Promise<void> {
    await this.authRepository.createAuthAuditEntry({
      ...input,
      outcome: "failure"
    });
  }
}

export function createAuthService(
  authRepository: AuthRepository = createAuthRepository(),
  totpSecretProtector: TotpSecretProtector = createDefaultTotpSecretProtector(),
  tokenIssuer: TokenIssuer = createDefaultTokenIssuer()
): AuthService {
  return new RepositoryAuthService(authRepository, totpSecretProtector, tokenIssuer);
}

function unauthorizedLoginResult(): StartLoginResult {
  return {
    status: "unauthorized",
    message: genericUnauthorizedMessage
  };
}

function invalidMfaResult(): CompleteMfaLoginResult {
  return {
    status: "unauthorized",
    message: "Invalid MFA code."
  };
}

function createDefaultTotpSecretProtector(): TotpSecretProtector {
  const key = loadTotpSecretEncryptionKey();
  const keyId = readOptionalStringEnv("TOTP_SECRET_KEY_ID") ?? localTotpSecretKeyId;

  return {
    async protect(secret: string): Promise<string> {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();

      return [
        encryptedTotpSecretPrefix,
        keyId,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url")
      ].join(":");
    },
    async reveal(protectedSecret: string): Promise<string> {
      const [version, storedKeyId, iv, tag, ciphertext] = protectedSecret.split(":");

      if (
        version !== encryptedTotpSecretPrefix ||
        storedKeyId !== keyId ||
        iv === undefined ||
        tag === undefined ||
        ciphertext === undefined
      ) {
        throw new Error("Unsupported TOTP secret envelope.");
      }

      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final()
      ]);

      return plaintext.toString("utf8");
    },
    keyId(): string {
      return keyId;
    }
  };
}

function createDefaultTokenIssuer(): TokenIssuer {
  return {
    issue: issueTokenPair
  };
}

function loadTotpSecretEncryptionKey(): Buffer {
  const configuredKey =
    readOptionalStringEnv("TOTP_SECRET_ENCRYPTION_KEY") ??
    readOptionalFileEnv("TOTP_SECRET_ENCRYPTION_KEY_FILE");

  if (configuredKey !== undefined) {
    const key = Buffer.from(configuredKey, "base64");

    if (key.length !== 32) {
      throw new Error("TOTP_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    }

    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("TOTP_SECRET_ENCRYPTION_KEY must be configured in production.");
  }

  generatedLocalTotpKey ??= randomBytes(32);

  return generatedLocalTotpKey;
}

function readOptionalStringEnv(name: string): string | undefined {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

function readOptionalFileEnv(name: string): string | undefined {
  const path = readOptionalStringEnv(name);

  if (path === undefined) {
    return undefined;
  }

  return readFileSync(path, "utf8").trim();
}
