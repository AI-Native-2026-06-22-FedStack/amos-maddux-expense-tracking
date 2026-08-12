import { mapProblemResponse } from "./errors";
import { getExpenseFlowApiBaseUrl } from "./config";

const correlationIdHeader = "X-Correlation-Id";

export interface ApiClient {
  requestJson<TResponse>(path: string, options?: ApiRequestOptions): Promise<TResponse>;
}

export interface ApiRequestOptions {
  body?: object;
  headers?: HeadersInit;
  method?: string;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl?: string;
  createCorrelationId?: () => string;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string | null;
  onRefreshFailed?: () => void;
  refreshSession?: () => Promise<string | null>;
}

interface RequestAttemptOptions extends ApiRequestOptions {
  correlationId: string;
  refreshedAccessToken?: string | null;
  retriedAfterRefresh: boolean;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? getExpenseFlowApiBaseUrl();
  let refreshInFlight: Promise<string | null> | undefined;

  const refreshOnce = async (): Promise<string | null> => {
    if (options.refreshSession === undefined) {
      throw new Error("No refresh session handler is configured.");
    }

    if (refreshInFlight === undefined) {
      refreshInFlight = options.refreshSession().finally(() => {
        refreshInFlight = undefined;
      });
    }

    return refreshInFlight;
  };

  const requestJson = async <TResponse>(
    path: string,
    requestOptions: ApiRequestOptions = {}
  ): Promise<TResponse> =>
    requestJsonAttempt<TResponse>(path, {
      ...requestOptions,
      correlationId: options.createCorrelationId?.() ?? createDefaultCorrelationId(),
      retriedAfterRefresh: false
    });

  const requestJsonAttempt = async <TResponse>(
    path: string,
    requestOptions: RequestAttemptOptions
  ): Promise<TResponse> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const accessToken = requestOptions.refreshedAccessToken ?? options.getAccessToken?.();
    const response = await fetchImpl(resolveUrl(path, baseUrl), {
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      headers: createHeaders(requestOptions.headers, accessToken, requestOptions.correlationId),
      method: requestOptions.method ?? (requestOptions.body === undefined ? "GET" : "POST"),
      signal: requestOptions.signal
    });

    if (response.ok) {
      return response.json().catch((): unknown => null) as TResponse;
    }

    if (response.status === 401 && !requestOptions.retriedAfterRefresh) {
      let refreshedAccessToken: string | null;

      try {
        refreshedAccessToken = await refreshOnce();
      } catch {
        options.onRefreshFailed?.();
        throw await mapProblemResponse(response, requestOptions.correlationId);
      }

      return requestJsonAttempt<TResponse>(path, {
        ...requestOptions,
        refreshedAccessToken,
        retriedAfterRefresh: true
      });
    }

    throw await mapProblemResponse(response, requestOptions.correlationId);
  };

  return {
    requestJson
  };
}

function createHeaders(
  inputHeaders: HeadersInit | undefined,
  accessToken: string | null | undefined,
  correlationId: string
): Headers {
  const headers = new Headers(inputHeaders);

  headers.set(correlationIdHeader, correlationId);

  if (accessToken !== null && accessToken !== undefined) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}

function resolveUrl(path: string, baseUrl: string): string {
  if (/^https?:\/\//u.test(path)) {
    return path;
  }

  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

function createDefaultCorrelationId(): string {
  return crypto.randomUUID();
}
