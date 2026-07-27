import { RequestHandler } from "express";
import inject from "light-my-request";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { issueTokenPair } from "../auth/tokens.js";
import { ExpenseReportController } from "../controllers/expense-report-controller.js";
import { UpstreamEngineError } from "../errors/problem-json.js";
import type { ExpenseReportService } from "../services/expense-report-service.js";

const tenantId = "00000000-0000-4000-8000-000000000901";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000902";

describe("Expense Report route rate-limit wiring", () => {
  it("rejects unauthenticated write requests before rate limiters run", async () => {
    let limiterCalled = false;
    const app = createApp({
      expenseWriteRateLimiters: [
        (_request, _response, next) => {
          limiterCalled = true;
          next();
        }
      ]
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(limiterCalled).toBe(false);
  });

  it("rejects unauthenticated write requests before idempotency middleware runs", async () => {
    let idempotencyMiddlewareCalled = false;
    const app = createApp({
      expenseReportIdempotencyMiddleware: (_request, _response, next) => {
        idempotencyMiddlewareCalled = true;
        next();
      }
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(idempotencyMiddlewareCalled).toBe(false);
  });

  it("rejects unauthenticated submit requests before the controller runs", async () => {
    const service = makeExpenseReportService({
      submit: vi.fn()
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports/00000000-0000-4000-8000-000000000903/submit",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("runs submit idempotency before the controller effect", async () => {
    const sequence: string[] = [];
    const service = makeExpenseReportService({
      submit: vi.fn(async () => {
        sequence.push("controller");
        return {
          id: "00000000-0000-4000-8000-000000000903",
          tenantId,
          submitterId: userId,
          assignedOwnerId: null,
          managerApproverId: null,
          apReviewerId: null,
          paymentId: null,
          currentStage: "Submitted" as const,
          priority: "Normal" as const,
          dueDate: null,
          onHold: false,
          holdReason: null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
      })
    });
    const app = createApp({
      expenseReportIdempotencyMiddleware: (_request, _response, next) => {
        sequence.push("idempotency");
        next();
      },
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports/00000000-0000-4000-8000-000000000903/submit",
      headers: {
        authorization: createAuthorizationHeader(),
        "idempotency-key": "synthetic-submit-idempotency"
      },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(sequence).toEqual(["idempotency", "controller"]);
  });

  it("returns clean Problem JSON when submit engine coding fails", async () => {
    const app = createApp({
      expenseReportController: new ExpenseReportController(
        makeExpenseReportService({
          submit: vi.fn(async () => {
            throw new UpstreamEngineError("GL coding engine unavailable after retries.");
          })
        })
      )
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports/00000000-0000-4000-8000-000000000903/submit",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {}
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      type: "/problems/upstream-engine",
      title: "Bad Gateway",
      status: 502,
      detail: "GL coding engine unavailable after retries.",
      instance: "/v1/expense-reports/00000000-0000-4000-8000-000000000903/submit"
    });
  });

  it("runs write slow-down before the hard limiter and before the controller", async () => {
    const sequence: string[] = [];
    const slowDownLimiter: RequestHandler = (_request, _response, next) => {
      sequence.push("slow-down");
      next();
    };
    const hardLimiter: RequestHandler = (_request, response) => {
      sequence.push("hard-limit");
      response.status(429).json({ error: "Synthetic limiter response." });
    };
    const app = createApp({
      expenseWriteRateLimiters: [slowDownLimiter, hardLimiter]
    });

    const response = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: {
        currentStage: "Invalid Stage"
      }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "Synthetic limiter response." });
    expect(sequence).toEqual(["slow-down", "hard-limit"]);
  });

  it("does not apply write limiters to Expense Report reads", async () => {
    let limiterCalled = false;
    const app = createApp({
      expenseWriteRateLimiters: [
        (_request, response) => {
          limiterCalled = true;
          response.status(429).json({ error: "Synthetic limiter response." });
        }
      ]
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/not-a-uuid",
      headers: {
        authorization: createAuthorizationHeader()
      }
    });

    expect(response.statusCode).toBe(400);
    expect(limiterCalled).toBe(false);
  });

  it("requires authentication for the Case Queue route before reading any cases", async () => {
    const service = makeExpenseReportService({
      listCaseQueue: vi.fn()
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/case-queue"
    });

    expect(response.statusCode).toBe(401);
    expect(service.listCaseQueue).not.toHaveBeenCalled();
  });

  it("routes Case Queue reads before Expense Report id reads", async () => {
    const service = makeExpenseReportService({
      findReport: vi.fn(),
      listCaseQueue: vi.fn(async () => [
        {
          id: "00000000-0000-4000-8000-000000000904",
          currentStage: "Manager Approval" as const,
          priority: "High" as const,
          dueDate: null,
          onHold: false,
          updatedAt: new Date("2026-07-20T12:00:00.000Z")
        }
      ])
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/case-queue",
      headers: {
        authorization: createAuthorizationHeader({ tenantId, roles: ["Finance Admin"] })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(service.findReport).not.toHaveBeenCalled();
    expect(service.listCaseQueue).toHaveBeenCalledWith(tenantId);
    expect(response.json()).toEqual({
      cases: [
        {
          id: "00000000-0000-4000-8000-000000000904",
          currentStage: "Manager Approval",
          priority: "High",
          dueDate: null,
          onHold: false,
          updatedAt: "2026-07-20T12:00:00.000Z"
        }
      ]
    });
  });

  it("derives the Case Queue tenant from the bearer token", async () => {
    const tenantB = "00000000-0000-4000-8000-000000000905";
    const service = makeExpenseReportService({
      listCaseQueue: vi.fn(async () => [])
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/case-queue",
      headers: {
        authorization: createAuthorizationHeader({
          tenantId: tenantB,
          roles: ["Department Manager"]
        })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(service.listCaseQueue).toHaveBeenCalledWith(tenantB);
    expect(service.listCaseQueue).not.toHaveBeenCalledWith(tenantId);
  });

  it("routes Case Queue rollup reads through the Finance Dashboard service path", async () => {
    const service = makeExpenseReportService({
      findReport: vi.fn(),
      listCaseQueueRollup: vi.fn(async () => [
        { stage: "Drafted" as const, reportCount: 2, overdueCount: 1 },
        { stage: "Submitted" as const, reportCount: 1, overdueCount: 0 },
        { stage: "Manager Approval" as const, reportCount: 0, overdueCount: 0 },
        { stage: "AP Review" as const, reportCount: 0, overdueCount: 0 },
        { stage: "Paid" as const, reportCount: 0, overdueCount: 0 },
        { stage: "Reconciled" as const, reportCount: 0, overdueCount: 0 }
      ])
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/case-queue/rollup",
      headers: {
        authorization: createAuthorizationHeader({ tenantId, roles: ["Finance Admin"] })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(service.findReport).not.toHaveBeenCalled();
    expect(service.listCaseQueueRollup).toHaveBeenCalledWith({
      tenantId,
      roles: ["Finance Admin"]
    });
    expect(response.json()).toEqual({
      summaries: [
        { stage: "Drafted", reportCount: 2, overdueCount: 1 },
        { stage: "Submitted", reportCount: 1, overdueCount: 0 },
        { stage: "Manager Approval", reportCount: 0, overdueCount: 0 },
        { stage: "AP Review", reportCount: 0, overdueCount: 0 },
        { stage: "Paid", reportCount: 0, overdueCount: 0 },
        { stage: "Reconciled", reportCount: 0, overdueCount: 0 }
      ]
    });
  });

  it("rejects Employee access to the internal Case Queue route", async () => {
    const service = makeExpenseReportService({
      listCaseQueue: vi.fn(async () => [])
    });
    const app = createApp({
      expenseReportController: new ExpenseReportController(service)
    });

    const response = await inject(app, {
      method: "GET",
      url: "/v1/expense-reports/case-queue",
      headers: {
        authorization: createAuthorizationHeader({ roles: ["Employee"] })
      }
    });

    expect(response.statusCode).toBe(403);
    expect(service.listCaseQueue).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET" as const, url: "/health", statusCode: 200 },
    { method: "GET" as const, url: "/docs", statusCode: 200 },
    { method: "POST" as const, url: "/v1/auth/login", statusCode: 400, payload: {} }
  ])(
    "does not apply write limiters to $method $url",
    async ({ method, url, statusCode, payload }) => {
      let limiterCalled = false;
      const app = createApp({
        expenseWriteRateLimiters: [
          (_request, response) => {
            limiterCalled = true;
            response.status(429).json({ error: "Synthetic limiter response." });
          }
        ]
      });

      const response = await inject(app, {
        method,
        url,
        ...(payload === undefined ? {} : { payload })
      });

      expect(response.statusCode).toBe(statusCode);
      expect(limiterCalled).toBe(false);
    }
  );
});

function createAuthorizationHeader(options: { tenantId?: string; roles?: string[] } = {}): string {
  const tokenPair = issueTokenPair({
    tenantId: options.tenantId ?? tenantId,
    userId,
    roles: options.roles ?? ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}

function makeExpenseReportService(
  overrides: Partial<ExpenseReportService> = {}
): ExpenseReportService {
  return {
    createDraftReport: vi.fn(),
    findReport: vi.fn(),
    listApprovalQueueLineItems: vi.fn(),
    listCaseQueue: vi.fn(),
    listCaseQueueRollup: vi.fn(),
    approveLineItem: vi.fn(),
    rejectLineItem: vi.fn(),
    clearLineItemFlag: vi.fn(),
    updateLineItemDeductible: vi.fn(),
    submit: vi.fn(),
    submitForApReview: vi.fn(),
    advance: vi.fn(),
    reject: vi.fn(),
    ...overrides
  } as ExpenseReportService;
}
