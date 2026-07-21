import { describe, expect, it, vi } from "vitest";

import { RequestWithAuthContext } from "../auth/verifier.js";
import { ExpenseReportController } from "./expense-report-controller.js";
import { ExpenseReportService } from "../services/expense-report-service.js";

describe("ExpenseReportController", () => {
  it("parses invalid create bodies before calling the service", async () => {
    const service = {
      createDraftReport: vi.fn(),
      findReport: vi.fn(),
      submitForApReview: vi.fn()
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
      id: "00000000-0000-4000-8000-000000000331",
      tenantId: "00000000-0000-4000-8000-000000000321",
      submitterId: "synthetic-user-00000000-0000-4000-8000-000000000322",
      assignedOwnerId: null,
      managerApproverId: null,
      apReviewerId: null,
      paymentId: null,
      currentStage: "AP Review" as const,
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
      submitForApReview: vi.fn(async () => submittedReport)
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
          tenantId: "00000000-0000-4000-8000-000000000321",
          userId: "synthetic-user-00000000-0000-4000-8000-000000000322",
          roles: ["Employee"]
        },
        headers: {
          authorization: "Bearer synthetic-forwarded-token"
        },
        params: {
          id: "00000000-0000-4000-8000-000000000331"
        }
      },
      response
    );

    expect(service.submitForApReview).toHaveBeenCalledWith({
      expenseReportId: "00000000-0000-4000-8000-000000000331",
      tenantId: "00000000-0000-4000-8000-000000000321",
      actorId: "synthetic-user-00000000-0000-4000-8000-000000000322",
      bearerToken: "synthetic-forwarded-token"
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(responseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000331",
        currentStage: "AP Review"
      })
    );
  });
});
