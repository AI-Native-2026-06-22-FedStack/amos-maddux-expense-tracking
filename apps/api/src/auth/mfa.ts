import { generate, generateSecret, generateURI, verify } from "otplib";

const issuer = "ExpenseFlow";
const totpDigits = 6;
const totpPeriodSeconds = 30;

export interface TotpEnrollmentRequest {
  accountName: string;
  issuer?: string;
}

export interface TotpEnrollment {
  secret: string;
  provisioningUri: string;
}

export interface TotpVerificationRequest {
  secret: string;
  code: string;
}

export function createTotpEnrollment(request: TotpEnrollmentRequest): TotpEnrollment {
  const enrollmentIssuer = request.issuer ?? issuer;
  const secret = generateSecret();
  const provisioningUri = generateURI({
    issuer: enrollmentIssuer,
    label: request.accountName,
    secret,
    digits: totpDigits,
    period: totpPeriodSeconds
  });

  return { secret, provisioningUri };
}

export function generateTotpCode(secret: string): Promise<string> {
  return generate({
    secret,
    digits: totpDigits,
    period: totpPeriodSeconds
  });
}

export async function verifyTotpCode(request: TotpVerificationRequest): Promise<boolean> {
  const result = await verify({
    secret: request.secret,
    token: request.code,
    digits: totpDigits,
    period: totpPeriodSeconds,
    epochTolerance: 0
  });

  return result.valid;
}
