import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIssuePaymentHandler,
  createIssuePaymentInitState,
  loadIssuePaymentConfig,
  type ApiGatewayHttpEvent,
  type CoreCaseServiceClient,
  type IssuePaymentLogger,
  type LambdaContext
} from "../src/index.js";

const expenseReportId = "00000000-0000-4000-8000-000000000101";
const correlationId = "synthetic-lambda-correlation-id";
const authorization = "Bearer synthetic-lambda-token";

describe("Issue-Payment Lambda handler", () => {
  let client: CoreCaseServiceClient;
  let logger: IssuePaymentLogger;

  beforeEach(() => {
    client = {
      advanceExpenseReport: vi.fn().mockResolvedValue({
        statusCode: 200,
        body: JSON.stringify({ id: expenseReportId, currentStage: "Reconciled" }),
        contentType: "application/json"
      })
    };
    logger = {
      addContext: vi.fn(),
      appendKeys: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
  });

  it("forwards the command to the Core Case Service advance endpoint inputs", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    const response = await handler(
      makeEvent({
        body: JSON.stringify({ reason: "Synthetic settlement complete." })
      }),
      makeContext()
    );

    expect(response.statusCode).toBe(200);
    expect(client.advanceExpenseReport).toHaveBeenCalledWith({
      expenseReportId,
      authorization,
      correlationId,
      reason: "Synthetic settlement complete."
    });
    expect(response.headers).toMatchObject({ "x-correlation-id": correlationId });
  });

  it("adds Lambda context and appends the supplied correlation ID to Powertools logs", async () => {
    const context = makeContext();
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    await handler(makeEvent(), context);

    expect(logger.addContext).toHaveBeenCalledWith(context);
    expect(logger.appendKeys).toHaveBeenCalledWith({ correlationId });
    expect(logger.info).toHaveBeenCalledWith(
      "issuePayment.invoked",
      expect.objectContaining({
        expenseReportId,
        initInstanceId: "synthetic-init-instance"
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "issuePayment.forwarded",
      expect.objectContaining({
        expenseReportId,
        statusCode: 200,
        initInstanceId: "synthetic-init-instance"
      })
    );
  });

  it("generates a correlation ID when the request does not supply one", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    const response = await handler(
      makeEvent({
        headers: {
          authorization
        }
      }),
      makeContext()
    );

    expect(logger.appendKeys).toHaveBeenCalledWith({
      correlationId: expect.any(String)
    });
    expect(response.headers).toMatchObject({
      "x-correlation-id": expect.any(String)
    });
  });

  it("rejects requests missing the expenseReportId path parameter", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    const response = await handler(makeEvent({ pathParameters: {}, rawPath: "/v1/expense-reports/issue-payment" }), makeContext());

    expect(response.statusCode).toBe(400);
    expect(client.advanceExpenseReport).not.toHaveBeenCalled();
  });

  it("reads the expenseReportId from the raw proxy path when pathParameters are absent", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    const response = await handler(
      makeEvent({
        pathParameters: {},
        rawPath: `/v1/expense-reports/${expenseReportId}/issue-payment`
      }),
      makeContext()
    );

    expect(response.statusCode).toBe(200);
    expect(client.advanceExpenseReport).toHaveBeenCalledWith(
      expect.objectContaining({
        expenseReportId
      })
    );
  });

  it("rejects requests missing Authorization", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    const response = await handler(
      makeEvent({
        headers: {
          "x-correlation-id": correlationId
        }
      }),
      makeContext()
    );

    expect(response.statusCode).toBe(401);
    expect(client.advanceExpenseReport).not.toHaveBeenCalled();
  });

  it("does not carry body values from one invocation to the next", async () => {
    const handler = createIssuePaymentHandler(makeInitState(client, logger));

    await handler(makeEvent({ body: JSON.stringify({ reason: "First synthetic reason." }) }), makeContext());
    await handler(makeEvent(), makeContext());

    expect(client.advanceExpenseReport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reason: "First synthetic reason." })
    );
    expect(client.advanceExpenseReport).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ reason: expect.any(String) })
    );
  });

  it("creates config, client, and logger in the init factory", () => {
    const initState = createIssuePaymentInitState({
      CORE_CASE_SERVICE_URL: "http://core-case-service:3000/"
    });

    expect(initState.config.coreCaseServiceUrl).toBe("http://core-case-service:3000");
    expect(initState.client).toBeDefined();
    expect(initState.logger).toBeDefined();
    expect(initState.initInstanceId).toMatch(/^synthetic-init-/);
  });
});

describe("loadIssuePaymentConfig", () => {
  it("requires CORE_CASE_SERVICE_URL", () => {
    expect(() => loadIssuePaymentConfig({})).toThrow("CORE_CASE_SERVICE_URL is required.");
  });
});

function makeInitState(client: CoreCaseServiceClient, logger: IssuePaymentLogger) {
  return {
    client,
    config: {
      coreCaseServiceUrl: "http://core-case-service:3000"
    },
    initInstanceId: "synthetic-init-instance",
    logger
  };
}

function makeEvent(overrides: Partial<ApiGatewayHttpEvent> = {}): ApiGatewayHttpEvent {
  return {
    version: "2.0",
    routeKey: "POST /v1/expense-reports/{expenseReportId}/issue-payment",
    rawPath: `/v1/expense-reports/${expenseReportId}/issue-payment`,
    rawQueryString: "",
    headers: {
      authorization,
      "x-correlation-id": correlationId
    },
    pathParameters: {
      expenseReportId
    },
    isBase64Encoded: false,
    ...overrides
  };
}

function makeContext(): LambdaContext {
  return {
    functionName: "expenseflow-issue-payment",
    functionVersion: "$LATEST",
    invokedFunctionArn: "synthetic-issue-payment-function",
    memoryLimitInMB: "256",
    awsRequestId: "synthetic-aws-request-id",
    logGroupName: "/aws/lambda/expenseflow-issue-payment",
    logStreamName: "synthetic-log-stream",
    getRemainingTimeInMillis: () => 30_000
  };
}
