export interface ApiProblemDetails {
  detail: string;
  instance?: string;
  status: number;
  title: string;
  type: string;
}

export class ApiProblemError extends Error {
  public readonly correlationId: string | null;
  public readonly detail: string;
  public readonly instance: string | undefined;
  public readonly kind = "problem" as const;
  public readonly status: number;
  public readonly title: string;
  public readonly type: string;

  public constructor(problem: ApiProblemDetails, correlationId: string | null = null) {
    super(problem.detail);
    this.name = "ApiProblemError";
    this.correlationId = correlationId;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.status = problem.status;
    this.title = problem.title;
    this.type = problem.type;
  }
}

export async function mapProblemResponse(
  response: Response,
  correlationId: string | null
): Promise<ApiProblemError> {
  const body = await response.json().catch((): unknown => null);
  const parsedProblem = parseProblemJson(body, response.status);

  return new ApiProblemError(parsedProblem, correlationId);
}

function parseProblemJson(body: unknown, fallbackStatus: number): ApiProblemDetails {
  if (!isRecord(body)) {
    return fallbackProblem(fallbackStatus);
  }

  const status = typeof body.status === "number" ? body.status : fallbackStatus;
  const title = typeof body.title === "string" ? body.title : fallbackTitle(status);
  const detail = typeof body.detail === "string" ? body.detail : `${title}.`;
  const type = typeof body.type === "string" ? body.type : "about:blank";
  const instance = typeof body.instance === "string" ? body.instance : undefined;

  return {
    detail,
    instance,
    status,
    title,
    type
  };
}

function fallbackProblem(status: number): ApiProblemDetails {
  const title = fallbackTitle(status);

  return {
    detail: `${title}.`,
    status,
    title,
    type: "about:blank"
  };
}

function fallbackTitle(status: number): string {
  return status === 0 ? "Network Error" : `HTTP ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
