import { randomUUID } from "node:crypto";

import { Logger } from "@aws-lambda-powertools/logger";

const correlationIdHeader = "x-correlation-id";
const authorizationHeader = "authorization";
const serviceName = "expenseflow-issue-payment";

export interface IssuePaymentConfig {
  coreCaseServiceUrl: string;
}

export interface ApiGatewayHttpEvent {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined>;
  path?: string;
  rawPath?: string;
  rawQueryString?: string;
  routeKey?: string;
  version?: string;
}

export interface LambdaContext {
  awsRequestId: string;
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
  getRemainingTimeInMillis(): number;
}

export interface LambdaProxyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface CoreCaseServiceClient {
  advanceExpenseReport(request: AdvanceExpenseReportCommand): Promise<CoreCaseServiceResponse>;
}

export interface AdvanceExpenseReportCommand {
  expenseReportId: string;
  authorization: string;
  correlationId: string;
  reason?: string;
}

export interface CoreCaseServiceResponse {
  statusCode: number;
  body: string;
  contentType?: string;
}

export interface IssuePaymentLogger {
  addContext(context: LambdaContext): void;
  appendKeys(keys: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface IssuePaymentInitState {
  client: CoreCaseServiceClient;
  config: IssuePaymentConfig;
  initInstanceId: string;
  logger: IssuePaymentLogger;
}

type Environment = Record<string, string | undefined>;

class FetchCoreCaseServiceClient implements CoreCaseServiceClient {
  public constructor(
    private readonly config: IssuePaymentConfig,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  public async advanceExpenseReport(
    request: AdvanceExpenseReportCommand
  ): Promise<CoreCaseServiceResponse> {
    const url = new URL(
      `/v1/expense-reports/${request.expenseReportId}/advance`,
      this.config.coreCaseServiceUrl
    );
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        authorization: request.authorization,
        "content-type": "application/json",
        [correlationIdHeader]: request.correlationId
      },
      body: JSON.stringify(request.reason === undefined ? {} : { reason: request.reason })
    });

    return {
      statusCode: response.status,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? undefined
    };
  }
}

export function loadIssuePaymentConfig(environment: Environment = process.env): IssuePaymentConfig {
  const rawCoreCaseServiceUrl = environment.CORE_CASE_SERVICE_URL?.trim();

  if (rawCoreCaseServiceUrl === undefined || rawCoreCaseServiceUrl.length === 0) {
    throw new Error("CORE_CASE_SERVICE_URL is required.");
  }

  return {
    coreCaseServiceUrl: new URL(rawCoreCaseServiceUrl).toString().replace(/\/$/, "")
  };
}

export function createCoreCaseServiceClient(config: IssuePaymentConfig): CoreCaseServiceClient {
  return new FetchCoreCaseServiceClient(config);
}

export function createIssuePaymentInitState(
  environment: Environment = process.env
): IssuePaymentInitState {
  const config = loadIssuePaymentConfig(environment);
  const logger = new Logger({ serviceName }) as unknown as IssuePaymentLogger;
  const client = createCoreCaseServiceClient(config);
  const initInstanceId = `synthetic-init-${randomUUID()}`;

  logger.info("issuePayment.initialized", {
    initInstanceId,
    coreCaseServiceUrl: config.coreCaseServiceUrl
  });

  return {
    client,
    config,
    initInstanceId,
    logger
  };
}

export function createIssuePaymentHandler(initState: IssuePaymentInitState) {
  return async (
    event: ApiGatewayHttpEvent,
    context: LambdaContext
  ): Promise<LambdaProxyResponse> => {
    const correlationId = readHeader(event.headers, correlationIdHeader) ?? randomUUID();

    initState.logger.addContext(context);
    initState.logger.appendKeys({ correlationId });

    const expenseReportId = readExpenseReportId(event);
    if (expenseReportId === undefined || expenseReportId.length === 0) {
      initState.logger.warn("issuePayment.rejected", {
        reason: "missing-expense-report-id",
        initInstanceId: initState.initInstanceId
      });
      return jsonResponse(
        400,
        { message: "expenseReportId path parameter is required." },
        correlationId
      );
    }

    const authorization = readHeader(event.headers, authorizationHeader);
    if (authorization === undefined || authorization.trim().length === 0) {
      initState.logger.warn("issuePayment.rejected", {
        expenseReportId,
        reason: "missing-authorization",
        initInstanceId: initState.initInstanceId
      });
      return jsonResponse(401, { message: "Authorization header is required." }, correlationId);
    }

    const parsedBody = parseIssuePaymentBody(event);
    if (!parsedBody.ok) {
      initState.logger.warn("issuePayment.rejected", {
        expenseReportId,
        reason: "invalid-body",
        initInstanceId: initState.initInstanceId
      });
      return jsonResponse(400, { message: parsedBody.message }, correlationId);
    }

    initState.logger.info("issuePayment.invoked", {
      expenseReportId,
      hasReason: parsedBody.reason !== undefined,
      initInstanceId: initState.initInstanceId
    });

    try {
      const coreResponse = await initState.client.advanceExpenseReport({
        expenseReportId,
        authorization,
        correlationId,
        reason: parsedBody.reason
      });

      initState.logger.info("issuePayment.forwarded", {
        expenseReportId,
        statusCode: coreResponse.statusCode,
        initInstanceId: initState.initInstanceId
      });

      return {
        statusCode: coreResponse.statusCode,
        headers: responseHeaders(correlationId, coreResponse.contentType),
        body: coreResponse.body
      };
    } catch (error) {
      initState.logger.error("issuePayment.forwardFailed", {
        expenseReportId,
        initInstanceId: initState.initInstanceId,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse(
        502,
        { message: "Core Case Service command forwarding failed." },
        correlationId
      );
    }
  };
}

const initState = createIssuePaymentInitState();

export const handler = createIssuePaymentHandler(initState);

function readHeader(headers: ApiGatewayHttpEvent["headers"], name: string): string | undefined {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return typeof match?.[1] === "string" ? match[1] : undefined;
}

function readExpenseReportId(event: ApiGatewayHttpEvent): string | undefined {
  const pathParameter = event.pathParameters?.expenseReportId?.trim();
  if (pathParameter !== undefined && pathParameter.length > 0) {
    return pathParameter;
  }

  const path = event.rawPath ?? event.path;
  const match = path?.match(/\/v1\/expense-reports\/([^/]+)\/issue-payment\/?$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]).trim();
}

function parseIssuePaymentBody(
  event: Pick<ApiGatewayHttpEvent, "body" | "isBase64Encoded">
): { ok: true; reason?: string } | { ok: false; message: string } {
  if (event.body === undefined || event.body === null || event.body.trim().length === 0) {
    return { ok: true };
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const reason = (parsed as { reason?: unknown }).reason;
  if (reason === undefined) {
    return { ok: true };
  }

  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500) {
    return {
      ok: false,
      message: "reason must be a non-empty string no longer than 500 characters."
    };
  }

  return { ok: true, reason: reason.trim() };
}

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
  correlationId: string
): LambdaProxyResponse {
  return {
    statusCode,
    headers: responseHeaders(correlationId, "application/json"),
    body: JSON.stringify(body)
  };
}

function responseHeaders(
  correlationId: string,
  contentType = "application/json"
): Record<string, string> {
  return {
    "content-type": contentType,
    "x-correlation-id": correlationId
  };
}
