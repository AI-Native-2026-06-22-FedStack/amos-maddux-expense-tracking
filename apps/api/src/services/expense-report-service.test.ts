import { describe, expect, it, vi } from "vitest";

import {
  BoundaryContractError,
  ConflictError,
  UpstreamEngineError
} from "../errors/problem-json.js";
import type { GlCodingEngineClient } from "../engine/gl-client.js";
import type { ExpenseReportRepository } from "../repository/expense-report-repository.js";
import { createExpenseReportService } from "./expense-report-service.js";
import { makeExpenseReport } from "../../test/factories/make-expense-report.js";

const tenantId = "00000000-0000-4000-8000-000000000501";
const reportId = "00000000-0000-4000-8000-000000000502";
const actorId = "synthetic-user-00000000-0000-4000-8000-000000000503";
const managerId = "synthetic-manager-00000000-0000-4000-8000-000000000506";
const lineItemId = "00000000-0000-4000-8000-000000000504";
const mileageEntryId = "00000000-0000-4000-8000-000000000505";

describe("ExpenseReportService submit", () => {
  it("builds the shared GL coding request and persists flags after engine success", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Drafted" });
    const submittedReport = { ...report, currentStage: "Submitted" as const };
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ id: lineItemId, amount_cents: 50001, category: "Meals" })],
        mileageEntries: [makeMileageEntry({ id: mileageEntryId, miles: "18.25" })]
      })),
      submitForApReview: vi.fn(async () => submittedReport)
    });
    const engineClient = {
      codeExpenseReport: vi.fn(async () => ({
        coded_line_items: [
          {
            status: "mapped",
            line_item_id: lineItemId,
            category: "Meals",
            gl_code_id: "00000000-0000-4000-8000-000000000601",
            account_code: "6100",
            account_name: "Synthetic Meals Expense",
            normal_balance: "debit",
            flagged: true
          }
        ],
        coded_mileage_entries: [],
        flagged_line_item: lineItemId
      }))
    } satisfies GlCodingEngineClient;
    const service = createExpenseReportService(repository, engineClient);

    await expect(
      service.submit({
        expenseReportId: reportId,
        tenantId,
        actorId,
        bearerToken: "synthetic-forwarded-token"
      })
    ).resolves.toMatchObject({ currentStage: "Submitted" });

    expect(engineClient.codeExpenseReport).toHaveBeenCalledWith(
      {
        line_items: [
          {
            line_item_id: lineItemId,
            amount: "500.01",
            currency: "USD",
            category: "Meals"
          }
        ],
        mileage_entries: [
          {
            mileage_entry_id: mileageEntryId,
            miles: "18.25",
            category: "Mileage"
          }
        ]
      },
      "synthetic-forwarded-token"
    );
    expect(repository.submitForApReview).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId,
      flaggedLineItemIds: [lineItemId],
      codedLineItems: [
        {
          id: lineItemId,
          status: "mapped",
          flagged: true,
          glCodeId: "00000000-0000-4000-8000-000000000601",
          accountCode: "6100",
          accountName: "Synthetic Meals Expense",
          normalBalance: "debit",
          unmappedMarker: null
        }
      ]
    });
  });

  it("does not persist a submit transition when the engine is down", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Drafted" });
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ id: lineItemId })],
        mileageEntries: []
      }))
    });
    const engineClient = {
      codeExpenseReport: vi.fn(async () => {
        throw new UpstreamEngineError("Synthetic engine outage.");
      })
    } satisfies GlCodingEngineClient;
    const service = createExpenseReportService(repository, engineClient);

    await expect(
      service.submit({
        expenseReportId: reportId,
        tenantId,
        actorId,
        bearerToken: "synthetic-forwarded-token"
      })
    ).rejects.toThrow(UpstreamEngineError);

    expect(repository.submitForApReview).not.toHaveBeenCalled();
  });

  it("rejects engine responses that reference unknown line item IDs", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Drafted" });
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ id: lineItemId })],
        mileageEntries: []
      }))
    });
    const engineClient = {
      codeExpenseReport: vi.fn(async () => ({
        coded_line_items: [
          {
            status: "unmapped",
            line_item_id: "00000000-0000-4000-8000-000000000599",
            category: "Meals",
            unmapped_marker: "UNMAPPED_GL_CATEGORY",
            flagged: true
          }
        ],
        coded_mileage_entries: [],
        flagged_line_item: "00000000-0000-4000-8000-000000000599"
      }))
    } satisfies GlCodingEngineClient;
    const service = createExpenseReportService(repository, engineClient);

    await expect(
      service.submit({
        expenseReportId: reportId,
        tenantId,
        actorId,
        bearerToken: "synthetic-forwarded-token"
      })
    ).rejects.toThrow(BoundaryContractError);

    expect(repository.submitForApReview).not.toHaveBeenCalled();
  });

  it("rejects unsupported persisted categories before calling the engine", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Drafted" });
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ category: "Travel" })],
        mileageEntries: []
      }))
    });
    const engineClient = {
      codeExpenseReport: vi.fn()
    } satisfies GlCodingEngineClient;
    const service = createExpenseReportService(repository, engineClient);

    await expect(
      service.submit({
        expenseReportId: reportId,
        tenantId,
        actorId,
        bearerToken: "synthetic-forwarded-token"
      })
    ).rejects.toThrow(ConflictError);

    expect(engineClient.codeExpenseReport).not.toHaveBeenCalled();
    expect(repository.submitForApReview).not.toHaveBeenCalled();
  });

  it("rejects Employee advance attempts and records the denied attempt", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Submitted" });
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [],
        mileageEntries: []
      }))
    });
    const service = createExpenseReportService(repository, { codeExpenseReport: vi.fn() });

    await expect(
      service.advance({
        expenseReportId: reportId,
        tenantId,
        actorId,
        roles: ["Employee"]
      })
    ).rejects.toThrow("Employee cannot transition Expense Reports.");

    expect(repository.transitionStage).not.toHaveBeenCalled();
    expect(repository.recordDeniedTransition).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId,
      action: "Expense Report Transition Denied",
      reason: "Actor is not permitted to transition Expense Reports."
    });
  });

  it("blocks advancing a flagged Manager Approval report until the flag is cleared", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Manager Approval" });
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ flagged: true, flag_cleared: false })],
        mileageEntries: []
      }))
    });
    const service = createExpenseReportService(repository, { codeExpenseReport: vi.fn() });

    await expect(
      service.advance({
        expenseReportId: reportId,
        tenantId,
        actorId: managerId,
        roles: ["Department Manager"]
      })
    ).rejects.toThrow("Over-500 line items must be cleared before AP Review.");

    expect(repository.transitionStage).not.toHaveBeenCalled();
    expect(repository.recordDeniedTransition).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId: managerId,
      action: "Expense Report Transition Denied",
      reason: "Over-500 line items must be cleared before AP Review."
    });
  });

  it("sends Manager Approval reports back to Drafted with the required reason", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Manager Approval" });
    const draftedReport = { ...report, currentStage: "Drafted" as const };
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [makeLineItem({ flagged: true, flag_cleared: false })],
        mileageEntries: []
      })),
      transitionStage: vi.fn(async () => draftedReport)
    });
    const service = createExpenseReportService(repository, { codeExpenseReport: vi.fn() });

    await expect(
      service.reject({
        expenseReportId: reportId,
        tenantId,
        actorId: managerId,
        roles: ["Department Manager"],
        reason: "Synthetic receipt needs detail."
      })
    ).resolves.toMatchObject({ currentStage: "Drafted" });

    expect(repository.transitionStage).toHaveBeenCalledWith({
      expenseReportId: reportId,
      tenantId,
      actorId: managerId,
      fromStage: "Manager Approval",
      toStage: "Drafted",
      reason: "Synthetic receipt needs detail.",
      action: "Expense Report Sent Back"
    });
  });
});

function makeRepository(overrides: Partial<ExpenseReportRepository> = {}): ExpenseReportRepository {
  return {
    createDraftReport: vi.fn(),
    findById: vi.fn(),
    findForSubmit: vi.fn(),
    listAuditEntries: vi.fn(),
    listWithLineItems: vi.fn(),
    submitForApReview: vi.fn(),
    transitionStage: vi.fn(),
    recordDeniedTransition: vi.fn(),
    ...overrides
  } as ExpenseReportRepository;
}

function makeLineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: lineItemId,
    tenant_id: tenantId,
    expense_report_id: reportId,
    merchant: "Synthetic Merchant",
    amount_cents: 4250,
    currency: "USD",
    category: "Meals",
    flagged: false,
    flag_cleared: false,
    gl_coding_status: null,
    gl_code_id: null,
    gl_account_code: null,
    gl_account_name: null,
    gl_normal_balance: null,
    gl_unmapped_marker: null,
    deductible: false,
    created_at: new Date(),
    ...overrides
  };
}

function makeMileageEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: mileageEntryId,
    tenant_id: tenantId,
    expense_report_id: reportId,
    trip_date: "2026-07-17",
    origin: "Synthetic Origin",
    destination: "Synthetic Destination",
    miles: "18.25",
    business_purpose: "Synthetic business purpose",
    created_at: new Date(),
    ...overrides
  };
}
