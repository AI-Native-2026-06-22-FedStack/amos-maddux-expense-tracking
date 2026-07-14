import { CORRELATION_ID_HEADER } from "../middleware/correlation.js";
import { getApiRuntimeConfig } from "../config/runtime-config.js";
import type { ReadinessRequestContext } from "../repository/health-repository.js";

export interface ComputeHealthClient {
  isReady(context: ReadinessRequestContext): Promise<boolean>;
}

type Fetch = typeof fetch;

class FetchComputeHealthClient implements ComputeHealthClient {
  public constructor(
    private readonly baseUrl: string = getApiRuntimeConfig().COMPUTE_SERVICE_URL,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  public async isReady(context: ReadinessRequestContext): Promise<boolean> {
    try {
      const response = await this.fetchImpl(new URL("/health", this.baseUrl), {
        method: "GET",
        headers: {
          [CORRELATION_ID_HEADER]: context.correlationId
        }
      });

      if (!response.ok) {
        return false;
      }

      const body: unknown = await response.json();

      return isComputeHealthResponse(body) && body.status === "ok";
    } catch {
      return false;
    }
  }
}

export function createComputeHealthClient(
  baseUrl?: string,
  fetchImpl?: Fetch
): ComputeHealthClient {
  return new FetchComputeHealthClient(baseUrl, fetchImpl);
}

function isComputeHealthResponse(value: unknown): value is { status: string } {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.status === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
