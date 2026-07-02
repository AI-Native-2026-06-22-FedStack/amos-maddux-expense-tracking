import { Request } from "express";
import { describe, expect, it, vi } from "vitest";

import { ExpenseReportController } from "./expense-report-controller.js";
import { ExpenseReportService } from "../services/expense-report-service.js";

describe("ExpenseReportController", () => {
  it("parses invalid create bodies before calling the service", () => {
    const service = {
      createDraftReport: vi.fn(),
      findReport: vi.fn()
    } satisfies ExpenseReportService;
    const controller = new ExpenseReportController(service);
    const request = {
      body: {
        tenantId: "not-a-uuid",
        submitterId: ""
      }
    } satisfies Pick<Request, "body">;
    const response = {
      status: vi.fn(() => ({
        json: vi.fn()
      }))
    };

    expect(() => controller.createExpenseReport(request, response)).toThrow();
    expect(service.createDraftReport).not.toHaveBeenCalled();
  });
});
