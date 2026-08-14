import { z } from "zod";

import { getApiRuntimeConfig } from "../config/runtime-config.js";

export type EmployerEinValidationResult =
  | {
      checked: true;
      matched: boolean;
      reason: "matched" | "tin-not-issued" | "tin-not-found" | "legal-name-mismatch";
      registeredName?: string;
    }
  | {
      checked: false;
      reason: "acl-unavailable" | "acl-contract-error";
    };

export interface EmployerEinValidationRequest {
  correlationId: string;
  employerEin: string;
  employerLegalName: string;
}

export interface TivsAclClient {
  validateEmployerEin(request: EmployerEinValidationRequest): Promise<EmployerEinValidationResult>;
}

interface FetchTivsAclClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const verificationResponseSchema = z
  .object({
    matched: z.boolean(),
    reason: z.enum(["matched", "tin-not-issued", "tin-not-found", "legal-name-mismatch"]),
    registeredName: z.string().optional(),
    taxIdentifierType: z.literal("ein")
  })
  .strict();

class FetchTivsAclClient implements TivsAclClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: FetchTivsAclClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 750;
  }

  async validateEmployerEin(
    request: EmployerEinValidationRequest
  ): Promise<EmployerEinValidationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        new URL("/v1/taxpayer-verifications", this.getBaseUrl()),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-correlation-id": request.correlationId
          },
          body: JSON.stringify({
            legalName: request.employerLegalName,
            taxIdentifier: request.employerEin,
            taxIdentifierType: "ein"
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        return {
          checked: false,
          reason: "acl-unavailable"
        };
      }

      const parsedResponse = verificationResponseSchema.safeParse(await response.json());

      if (!parsedResponse.success) {
        return {
          checked: false,
          reason: "acl-contract-error"
        };
      }

      return {
        checked: true,
        matched: parsedResponse.data.matched,
        reason: parsedResponse.data.reason,
        ...(parsedResponse.data.registeredName === undefined
          ? {}
          : { registeredName: parsedResponse.data.registeredName })
      };
    } catch {
      return {
        checked: false,
        reason: "acl-unavailable"
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private getBaseUrl(): string {
    return this.baseUrl === "" ? getApiRuntimeConfig().TIVS_ACL_URL : this.baseUrl;
  }
}

export function createTivsAclClient(options?: FetchTivsAclClientOptions): TivsAclClient {
  return new FetchTivsAclClient(options);
}
