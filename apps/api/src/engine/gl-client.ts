import { getApiRuntimeConfig } from "../config/runtime-config.js";
import { BoundaryContractError, UpstreamEngineError } from "../errors/problem-json.js";
import {
  validateGlCodingRequestPayload,
  validateGlCodingResponsePayload
} from "../services/gl-coding-contract.js";

export interface GlCodingEngineClient {
  codeExpenseReport(request: GlCodingRequestPayload, bearerToken: string): Promise<unknown>;
}

export interface GlCodingRequestPayload {
  line_items: GlCodingLineItemPayload[];
  mileage_entries: GlCodingMileageEntryPayload[];
}

export interface GlCodingLineItemPayload {
  line_item_id: string;
  amount: string;
  currency: string;
  category: string;
}

export interface GlCodingMileageEntryPayload {
  mileage_entry_id: string;
  miles: string;
  category: "Mileage";
}

type Fetch = typeof fetch;

interface FetchGlCodingEngineClientOptions {
  baseUrl?: string;
  fetchImpl?: Fetch;
  maxAttempts?: number;
  perAttemptTimeoutMs?: number;
  baseBackoffMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

class FetchGlCodingEngineClient implements GlCodingEngineClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly maxAttempts: number;
  private readonly perAttemptTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(options: FetchGlCodingEngineClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? getApiRuntimeConfig().COMPUTE_SERVICE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? 750;
    this.baseBackoffMs = options.baseBackoffMs ?? 100;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  public async codeExpenseReport(
    request: GlCodingRequestPayload,
    bearerToken: string
  ): Promise<unknown> {
    validateGlCodingRequestPayload(request);

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.postCodingRequest(request, bearerToken);

        if (response.ok) {
          const payload: unknown = await response.json();
          validateGlCodingResponsePayload(payload);

          return payload;
        }

        if (!isTransientStatus(response.status)) {
          throw new UpstreamEngineError(
            `GL coding engine rejected the request with status ${response.status}.`
          );
        }

        lastError = new TransientEngineRequestError(
          `GL coding engine returned transient status ${response.status}.`
        );
      } catch (error) {
        if (error instanceof BoundaryContractError) {
          throw error;
        }

        if (error instanceof UpstreamEngineError && !isTransientUpstreamError(error)) {
          throw error;
        }

        lastError = error;
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(this.calculateBackoffMs(attempt));
      }
    }

    throw new UpstreamEngineError(
      lastError instanceof Error
        ? `GL coding engine unavailable after retries: ${lastError.message}`
        : "GL coding engine unavailable after retries."
    );
  }

  private async postCodingRequest(
    request: GlCodingRequestPayload,
    bearerToken: string
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.perAttemptTimeoutMs);

    try {
      return await this.fetchImpl(new URL("/v1/coding", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });
    } catch (error) {
      throw new TransientEngineRequestError(
        error instanceof Error ? error.message : "GL coding engine transport failed."
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private calculateBackoffMs(attempt: number): number {
    // Three short attempts keep submit bounded while giving transient engine restarts one recovery window.
    const exponentialBackoffMs = this.baseBackoffMs * 2 ** (attempt - 1);
    const jitterMs = Math.floor(this.random() * this.baseBackoffMs);

    return exponentialBackoffMs + jitterMs;
  }
}

export function createGlCodingEngineClient(
  options?: FetchGlCodingEngineClientOptions
): GlCodingEngineClient {
  return new FetchGlCodingEngineClient(options);
}

function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function isTransientUpstreamError(error: UpstreamEngineError): boolean {
  return error instanceof TransientEngineRequestError;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

class TransientEngineRequestError extends UpstreamEngineError {
  public constructor(message: string) {
    super(message);
    this.name = "TransientEngineRequestError";
  }
}
