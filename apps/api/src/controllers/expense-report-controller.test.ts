import { describe, expect, it, vi } from "vitest";

import { RequestWithAuthContext } from "../auth/verifier.js";
import { ExpenseReportController } from "./expense-report-controller.js";
import { ExpenseReportService } from "../services/expense-report-service.js";

describe("ExpenseReportController", () => {
  const tenantId = "00000000-0000-4000-8000-000000000321";
  const userId = "synthetic-user-00000000-0000-4000-8000-000000000322";
  const reportId = "00000000-0000-4000-8000-000000000331";
  const correlationId = "synthetic-controller-correlation-id";

  it("parses invalid create bodies before calling the service", async () => {
    const service = {
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
      reject: vi.fn()
    } satisfies ExpenseReportService;
    const controller = new ExpenseReportController(service);
    const request = {
      authContext: {
        tenantId: "00000000-0000-4000-8000-000000000321",
        userId: "synthetic-user-00000000-0000-4000-8000-000000000322",
        roles: ["Employee"]
      },
      body: {
        currentStage: "Invalid Stage"
      }
    } satisfies Pick<RequestWithAuthContext, "authContext" | "body">;
    const response = {
      status: vi.fn(() => ({
        json: vi.fn()
      }))
    };

    await expect(controller.createExpenseReport(request, response)).rejects.toThrow();
    expect(service.createDraftReport).not.toHaveBeenCalled();
  });

  it("forwards the authenticated bearer token on submit", async () => {
    const submittedReport = {
      id: reportId,
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
    const service = {
      createDraftReport: vi.fn(),
      findReport: vi.fn(),
      listApprovalQueueLineItems: vi.fn(),
      listCaseQueue: vi.fn(),
      listCaseQueueRollup: vi.fn(),
      approveLineItem: vi.fn(),
      rejectLineItem: vi.fn(),
      clearLineItemFlag: vi.fn(),
      updateLineItemDeductible: vi.fn(),
      submit: vi.fn(async () => submittedReport),
      submitForApReview: vi.fn(async () => submittedReport),
      advance: vi.fn(),
      reject: vi.fn()
    } satisfies ExpenseReportService;
    const controller = new ExpenseReportController(service);
    const responseJson = vi.fn();
    const response = {
      status: vi.fn(() => ({
        json: responseJson
      }))
    };

    await controller.submitExpenseReport(
      {
        authContext: {
          tenantId,
          userId,
          roles: ["Employee"]
        },
        correlationId,
        headers: {
          authorization: "Bearer synthetic-forwarded-token"
        },
        params: {
          id: reportId
        }
      },
      response
    );

    expect(service.submit).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId: userId,
      bearerToken: "synthetic-forwarded-token",
      correlationId
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(responseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        id: reportId,
        currentStage: "Submitted"
      })
    );
  });

  it("forwards the request correlation ID on advance", async () => {
    const advancedReport = makeExpenseReportResponse({ currentStage: "Manager Approval" });
    const service = makeExpenseReportService({
      advance: vi.fn(async () => advancedReport)
    });
    const controller = new ExpenseReportController(service);

    await controller.advanceExpenseReport(
      {
        authContext: {
          tenantId,
          userId,
          roles: ["Department Manager"]
        },
        body: {},
        correlationId,
        params: {
          id: reportId
        }
      },
      makeJsonResponse()
    );

    expect(service.advance).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId: userId,
      roles: ["Department Manager"],
      correlationId,
      reason: undefined
    });
  });

  it("forwards the request correlation ID on reject", async () => {
    const rejectedReport = makeExpenseReportResponse({ currentStage: "Drafted" });
    const service = makeExpenseReportService({
      reject: vi.fn(async () => rejectedReport)
    });
    const controller = new ExpenseReportController(service);

    await controller.rejectExpenseReport(
      {
        authContext: {
          tenantId,
          userId,
          roles: ["Platform Admin"]
        },
        body: {
          reason: "Synthetic report needs receipt detail."
        },
        correlationId,
        params: {
          id: reportId
        }
      },
      makeJsonResponse()
    );

    expect(service.reject).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId: userId,
      roles: ["Platform Admin"],
      correlationId,
      reason: "Synthetic report needs receipt detail."
    });
  });
});

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
  } satisfies ExpenseReportService;
}

function makeExpenseReportResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000331",
    tenantId: "00000000-0000-4000-8000-000000000321",
    submitterId: "synthetic-user-00000000-0000-4000-8000-000000000322",
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
    updatedAt: new Date(),
    ...overrides
  };
}

function makeJsonResponse() {
  return {
    status: vi.fn(() => ({
      json: vi.fn()
    }))
  };
}
