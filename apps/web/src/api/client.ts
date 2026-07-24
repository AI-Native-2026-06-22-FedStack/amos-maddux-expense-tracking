import { mapProblemResponse } from "./errors";

const defaultBaseUrl = "/v1";
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
  refreshSession?: () => Promise<void>;
}

interface RequestAttemptOptions extends ApiRequestOptions {
  retriedAfterRefresh: boolean;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl;
  let refreshInFlight: Promise<void> | undefined;

  const refreshOnce = async (): Promise<void> => {
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
      retriedAfterRefresh: false
    });

  const requestJsonAttempt = async <TResponse>(
    path: string,
    requestOptions: RequestAttemptOptions
  ): Promise<TResponse> => {
    const correlationId = options.createCorrelationId?.() ?? createDefaultCorrelationId();
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(resolveUrl(path, baseUrl), {
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      headers: createHeaders(requestOptions.headers, options.getAccessToken?.(), correlationId),
      method: requestOptions.method ?? (requestOptions.body === undefined ? "GET" : "POST"),
      signal: requestOptions.signal
    });

    if (response.ok) {
      return response.json().catch((): unknown => null) as TResponse;
    }

    if (response.status === 401 && !requestOptions.retriedAfterRefresh) {
      try {
        await refreshOnce();
      } catch {
        options.onRefreshFailed?.();
        throw await mapProblemResponse(response, correlationId);
      }

      return requestJsonAttempt<TResponse>(path, {
        ...requestOptions,
        retriedAfterRefresh: true
      });
    }

    throw await mapProblemResponse(response, correlationId);
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
