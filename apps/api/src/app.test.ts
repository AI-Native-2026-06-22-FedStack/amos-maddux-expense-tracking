import express from "express";
import inject from "light-my-request";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { issueTokenPair } from "./auth/tokens.js";
import { setApiRuntimeConfigForTest } from "./config/runtime-config.js";
import { sensitiveLogCensor, sensitiveLogPaths } from "./logger.js";
import { bindCorrelationId, CORRELATION_ID_HEADER_LOWERCASE } from "./middleware/correlation.js";

interface CapturedRequestLog {
  level: number;
  time: number;
  msg: string;
  req: {
    headers?: Record<string, unknown>;
  };
  res: unknown;
  correlationId?: unknown;
}

describe("createApp", () => {
  const authenticatedTenantId = "00000000-0000-4000-8000-000000000301";
  const authenticatedUserId = "synthetic-submitter-00000000-0000-4000-8000-000000000302";
  const validCreateRequest = {
    tenantId: "00000000-0000-4000-8000-000000000303",
    submitterId: "synthetic-submitter-00000000-0000-4000-8000-000000000304"
  };

  it("returns the service status body from GET /health", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "ExpenseFlow API",
      status: "ok"
    });
  });

  it("adds the default AI assist usage header to non-AI responses", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/health"
    });

    expect(response.headers["ai-assist-usage"]).toBe("cost=0; remaining=0");
  });

  it("emits parseable JSON request logs without sensitive headers", async () => {
    const { logLines, logger } = createCapturedLogger();
    const response = await inject(createApp({ logger }), {
      method: "GET",
      url: "/health",
      headers: {
        authorization: "Bearer synthetic-test-token"
      }
    });
    const parsedLog = parseLatestRequestLog(logLines);

    expect(response.statusCode).toBe(200);
    expect(parsedLog).toMatchObject({
      level: expect.any(Number),
      time: expect.any(Number),
      msg: expect.any(String),
      req: expect.any(Object),
      res: expect.any(Object)
    });
    expect(parsedLog.req?.headers?.authorization).toBe(sensitiveLogCensor);
    expect(logLines.join("")).not.toContain("synthetic-test-token");
  });

  it("reuses a supplied correlation ID in downstream request logs", async () => {
    const { logLines, logger } = createCapturedLogger();
    const suppliedCorrelationId = "synthetic-correlation-id";
    const response = await inject(createApp({ logger }), {
      method: "GET",
      url: "/health",
      headers: {
        [CORRELATION_ID_HEADER_LOWERCASE]: suppliedCorrelationId
      }
    });
    const parsedLog = parseLatestRequestLog(logLines);

    expect(response.statusCode).toBe(200);
    expect(response.headers[CORRELATION_ID_HEADER_LOWERCASE]).toBe(suppliedCorrelationId);
    expect(parsedLog.correlationId).toBe(suppliedCorrelationId);
  });

  it("generates a correlation ID when the request does not provide one", async () => {
    const { logLines, logger } = createCapturedLogger();
    const response = await inject(createApp({ logger }), {
      method: "GET",
      url: "/health"
    });
    const parsedLog = parseLatestRequestLog(logLines);

    expect(response.statusCode).toBe(200);
    expect(response.headers[CORRELATION_ID_HEADER_LOWERCASE]).toMatch(uuidRegex);
    expect(parsedLog.correlationId).toBe(response.headers[CORRELATION_ID_HEADER_LOWERCASE]);
  });

  it("does not replace a supplied correlation ID with a generated value", async () => {
    const { logLines, logger } = createCapturedLogger();
    const suppliedCorrelationId = "synthetic-non-uuid-correlation-id";
    const response = await inject(createApp({ logger }), {
      method: "GET",
      url: "/health",
      headers: {
        [CORRELATION_ID_HEADER_LOWERCASE]: suppliedCorrelationId
      }
    });
    const parsedLog = parseLatestRequestLog(logLines);

    expect(response.headers[CORRELATION_ID_HEADER_LOWERCASE]).toBe(suppliedCorrelationId);
    expect(parsedLog.correlationId).toBe(suppliedCorrelationId);
    expect(parsedLog.correlationId).not.toEqual(expect.stringMatching(uuidRegex));
  });

  it("generates a correlation ID when the supplied header is unusable", async () => {
    const { logLines, logger } = createCapturedLogger();
    const response = await inject(createApp({ logger }), {
      method: "GET",
      url: "/health",
      headers: {
        [CORRELATION_ID_HEADER_LOWERCASE]: "   "
      }
    });
    const parsedLog = parseLatestRequestLog(logLines);

    expect(response.headers[CORRELATION_ID_HEADER_LOWERCASE]).toMatch(uuidRegex);
    expect(parsedLog.correlationId).toBe(response.headers[CORRELATION_ID_HEADER_LOWERCASE]);
  });

  it("binds the correlation ID to downstream request logs", async () => {
    const { logLines, logger } = createCapturedLogger();
    const app = express();

    app.use(pinoHttp({ logger }));
    app.use(bindCorrelationId);
    app.get("/downstream-log", (request, response) => {
      request.log.info("Synthetic downstream route log.");
      response.status(204).end();
    });

    const response = await inject(app, {
      method: "GET",
      url: "/downstream-log",
      headers: {
        [CORRELATION_ID_HEADER_LOWERCASE]: "synthetic-downstream-correlation-id"
      }
    });
    const downstreamLog = parseJsonLogs(logLines).find(
      (logLine) => logLine.msg === "Synthetic downstream route log."
    );

    expect(response.statusCode).toBe(204);
    expect(downstreamLog?.correlationId).toBe("synthetic-downstream-correlation-id");
  });

  it("returns not ready from GET /ready when compute is unavailable", async () => {
    const previousComputeServiceUrl = process.env.COMPUTE_SERVICE_URL;
    process.env.COMPUTE_SERVICE_URL = "http://127.0.0.1:1";
    setApiRuntimeConfigForTest(undefined);

    try {
      const response = await inject(createApp(), {
        method: "GET",
        url: "/ready"
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        service: "ExpenseFlow API",
        status: "not ready"
      });
    } finally {
      if (previousComputeServiceUrl === undefined) {
        delete process.env.COMPUTE_SERVICE_URL;
      } else {
        process.env.COMPUTE_SERVICE_URL = previousComputeServiceUrl;
      }
      setApiRuntimeConfigForTest(undefined);
    }
  });

  it("serves the generated OpenAPI document", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/openapi.json"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      openapi: "3.1.0",
      servers: [{ url: "http://localhost:3000/v1" }],
      paths: {
        "/expense-reports": expect.any(Object),
        "/expense-reports/{id}": expect.any(Object)
      }
    });
  });

  it("renders the API docs page", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/docs"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("/openapi.json");
  });

  it("returns a 404 response for unmatched routes", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/missing-route"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: "Route not found.",
      instance: "/missing-route"
    });
  });

  it("routes thrown errors to the final error handler", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/health/error"
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      type: "/problems/internal-server-error",
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected server error occurred.",
      instance: "/health/error"
    });
    expect(response.body).not.toContain("Synthetic health route failure.");
    expect(response.body).not.toContain("stack");
  });

  it("creates a Drafted Expense Report from a valid request", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: validCreateRequest
    });
    const report = response.json<{
      id: string;
      tenantId: string;
      submitterId: string;
      assignedOwnerId: string | null;
      managerApproverId: string | null;
      apReviewerId: string | null;
      paymentId: string | null;
      currentStage: string;
      priority: string;
      dueDate: string | null;
      onHold: boolean;
      holdReason: string | null;
      createdAt: string;
      updatedAt: string;
    }>();

    expect(response.statusCode).toBe(201);
    expect(report).toMatchObject({
      tenantId: authenticatedTenantId,
      submitterId: authenticatedUserId,
      assignedOwnerId: null,
      managerApproverId: null,
      apReviewerId: null,
      paymentId: null,
      currentStage: "Drafted",
      priority: "Normal",
      dueDate: null,
      onHold: false,
      holdReason: null
    });
    expect(report.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(new Date(report.createdAt).toISOString()).toBe(report.createdAt);
    expect(new Date(report.updatedAt).toISOString()).toBe(report.updatedAt);
    expect(response.headers.deprecation).toBeUndefined();
    expect(response.headers.sunset).toBeUndefined();
    expect(response.headers.link).toBeUndefined();
  });

  it("keeps legacy Expense Report routes reachable with deprecation headers", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: validCreateRequest
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.deprecation).toBe("@1783987200");
    expect(response.headers.sunset).toBe("Mon, 12 Oct 2026 00:00:00 GMT");
    expect(response.headers.link).toBe('</v1/expense-reports>; rel="successor-version"');
  });

  it("emits deprecation headers on legacy Expense Report create validation failures", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {
        currentStage: "Invalid Stage"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers.deprecation).toBe("@1783987200");
    expect(response.headers.sunset).toBe("Mon, 12 Oct 2026 00:00:00 GMT");
    expect(response.headers.link).toBe('</v1/expense-reports>; rel="successor-version"');
  });

  it("emits deprecation headers on legacy auth routes", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/auth/login",
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers.deprecation).toBe("@1783987200");
    expect(response.headers.sunset).toBe("Mon, 12 Oct 2026 00:00:00 GMT");
    expect(response.headers.link).toBe('</v1/auth/login>; rel="successor-version"');
  });

  it("rejects invalid Expense Report create bodies before creation", async () => {
    const response = await inject(createApp(), {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {
        currentStage: "Invalid Stage"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: expect.stringContaining("currentStage"),
      instance: "/v1/expense-reports"
    });
  });

  it("reads an Expense Report after creation", async () => {
    const app = createApp();
    const createResponse = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: validCreateRequest
    });
    const createdReport = createResponse.json<{ id: string }>();

    const readResponse = await inject(app, {
      method: "GET",
      url: `/v1/expense-reports/${createdReport.id}?tenantId=${validCreateRequest.tenantId}`,
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toEqual(createResponse.json());
  });

  it("emits deprecation headers when reading legacy Expense Report routes", async () => {
    const app = createApp();
    const createResponse = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: validCreateRequest
    });
    const createdReport = createResponse.json<{ id: string }>();

    const readResponse = await inject(app, {
      method: "GET",
      url: `/expense-reports/${createdReport.id}?tenantId=${validCreateRequest.tenantId}`,
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.headers.deprecation).toBe("@1783987200");
    expect(readResponse.headers.sunset).toBe("Mon, 12 Oct 2026 00:00:00 GMT");
    expect(readResponse.headers.link).toBe(
      `</v1/expense-reports/${createdReport.id}>; rel="successor-version"`
    );
    expect(readResponse.json()).toEqual(createResponse.json());
  });

  it("rejects invalid Expense Report id params", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: "/v1/expense-reports/not-a-uuid",
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: expect.stringContaining("id"),
      instance: "/v1/expense-reports/not-a-uuid"
    });
  });

  it("returns 404 for an unknown valid Expense Report id", async () => {
    const response = await inject(createApp(), {
      method: "GET",
      url: `/v1/expense-reports/00000000-0000-4000-8000-000000000399?tenantId=${validCreateRequest.tenantId}`,
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: "Expense Report not found.",
      instance: `/v1/expense-reports/00000000-0000-4000-8000-000000000399?tenantId=${validCreateRequest.tenantId}`
    });
  });

  function createAuthorizationHeader(): string {
    const tokenPair = issueTokenPair({
      tenantId: authenticatedTenantId,
      userId: authenticatedUserId,
      roles: ["Employee"]
    });

    return `Bearer ${tokenPair.accessToken}`;
  }
});

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createCapturedLogger(): { logger: Logger; logLines: string[] } {
  const logLines: string[] = [];
  const logger = pino(
    {
      redact: {
        paths: sensitiveLogPaths,
        censor: sensitiveLogCensor
      }
    },
    {
      write(line) {
        logLines.push(line);
      }
    }
  );

  return { logger, logLines };
}

function parseLatestRequestLog(logLines: readonly string[]): CapturedRequestLog {
  const latestLine = logLines.at(-1);

  if (latestLine === undefined) {
    throw new Error("Expected at least one captured request log line.");
  }

  const parsed: unknown = JSON.parse(latestLine);

  if (!isCapturedRequestLog(parsed)) {
    throw new Error("Captured request log did not match the expected structure.");
  }

  return parsed;
}

function parseJsonLogs(logLines: readonly string[]): Record<string, unknown>[] {
  return logLines.map((line) => {
    const parsed: unknown = JSON.parse(line);

    if (!isRecord(parsed)) {
      throw new Error("Captured log line did not contain a JSON object.");
    }

    return parsed;
  });
}

function isCapturedRequestLog(value: unknown): value is CapturedRequestLog {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.level === "number" &&
    typeof value.time === "number" &&
    typeof value.msg === "string" &&
    isRecord(value.req) &&
    "res" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
