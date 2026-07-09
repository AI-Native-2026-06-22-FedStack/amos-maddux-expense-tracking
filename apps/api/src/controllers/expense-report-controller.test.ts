import { describe, expect, it, vi } from "vitest";

import { RequestWithAuthContext } from "../auth/verifier.js";
import { ExpenseReportController } from "./expense-report-controller.js";
import { ExpenseReportService } from "../services/expense-report-service.js";

describe("ExpenseReportController", () => {
  it("parses invalid create bodies before calling the service", async () => {
    const service = {
      createDraftReport: vi.fn(),
      findReport: vi.fn()
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
});
