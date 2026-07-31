import { describe, expect, it, vi } from "vitest";

import { ConflictError } from "../errors/problem-json.js";
import type { ExpenseReportRepository } from "../repository/expense-report-repository.js";
import { makeExpenseReport } from "../../test/factories/make-expense-report.js";
import { createSettlementSaga, type PaymentStub } from "./settlement-saga.js";

const tenantId = "00000000-0000-4000-8000-000000000701";
const reportId = "00000000-0000-4000-8000-000000000702";
const actorId = "synthetic-finance-admin-00000000-0000-4000-8000-000000000703";
const paymentId = "synthetic-payment-00000000-0000-4000-8000-000000000704";
const correlationId = "synthetic-settlement-correlation-id";

describe("Settlement saga", () => {
  it("compensates only the committed payment step when reconcile fails", async () => {
    const compensationOrder: string[] = [];
    const repository = makeRepository({
      issuePayment: vi.fn(async () =>
        makeExpenseReport({ id: reportId, tenantId, currentStage: "Paid", paymentId })
      ),
      voidIssuedPayment: vi.fn(async () => {
        compensationOrder.push("record-payment-voided");
      }),
      transitionStage: vi.fn(async () => {
        throw new ConflictError("Synthetic reconcile failure.");
      })
    });
    const paymentStub = makePaymentStub({
      voidPayment: vi.fn(async () => {
        compensationOrder.push("void-payment-stub");
      })
    });
    const saga = createSettlementSaga(repository, paymentStub);

    await expect(
      saga.settle({
        expenseReportId: reportId,
        tenantId,
        actorId,
        correlationId
      })
    ).rejects.toThrow("Synthetic reconcile failure.");

    expect(repository.issuePayment).toHaveBeenCalledExactlyOnceWith({
      expenseReportId: reportId,
      tenantId,
      actorId,
      paymentId
    });
    expect(repository.transitionStage).toHaveBeenCalledExactlyOnceWith({
      expenseReportId: reportId,
      tenantId,
      actorId,
      fromStage: "Paid",
      toStage: "Reconciled",
      correlationId,
      reason: "Expense Report settlement reconciled.",
      action: "Expense Report Reconciled"
    });
    expect(repository.unreconcileSettlement).not.toHaveBeenCalled();
    expect(paymentStub.voidPayment).toHaveBeenCalledExactlyOnceWith({ paymentId });
    expect(repository.voidIssuedPayment).toHaveBeenCalledExactlyOnceWith({
      expenseReportId: reportId,
      tenantId,
      actorId,
      paymentId,
      reason: "Settlement saga compensation voided the issued payment."
    });
    expect(compensationOrder).toEqual(["void-payment-stub", "record-payment-voided"]);
  });

  it("voids the external payment when recording the issued payment fails", async () => {
    const repository = makeRepository({
      issuePayment: vi.fn(async () => {
        throw new ConflictError("Synthetic payment failure.");
      })
    });
    const paymentStub = makePaymentStub();
    const saga = createSettlementSaga(repository, paymentStub);

    await expect(
      saga.settle({
        expenseReportId: reportId,
        tenantId,
        actorId,
        correlationId
      })
    ).rejects.toThrow("Synthetic payment failure.");

    expect(paymentStub.voidPayment).toHaveBeenCalledExactlyOnceWith({ paymentId });
    expect(repository.transitionStage).not.toHaveBeenCalled();
    expect(repository.unreconcileSettlement).not.toHaveBeenCalled();
    expect(repository.voidIssuedPayment).not.toHaveBeenCalled();
  });

  it("does not compensate when issuing the external payment fails", async () => {
    const paymentStub = makePaymentStub({
      issuePayment: vi.fn(async () => {
        throw new ConflictError("Synthetic external payment failure.");
      })
    });
    const repository = makeRepository();
    const saga = createSettlementSaga(repository, paymentStub);

    await expect(
      saga.settle({
        expenseReportId: reportId,
        tenantId,
        actorId,
        correlationId
      })
    ).rejects.toThrow("Synthetic external payment failure.");

    expect(paymentStub.voidPayment).not.toHaveBeenCalled();
    expect(repository.issuePayment).not.toHaveBeenCalled();
    expect(repository.transitionStage).not.toHaveBeenCalled();
  });
});

function makePaymentStub(overrides: Partial<PaymentStub> = {}): PaymentStub {
  return {
    issuePayment: vi.fn(async () => ({ id: paymentId })),
    voidPayment: vi.fn(async () => undefined),
    ...overrides
  };
}

function makeRepository(overrides: Partial<ExpenseReportRepository> = {}): ExpenseReportRepository {
  return {
    createDraftReport: vi.fn(),
    findById: vi.fn(),
    findForSubmit: vi.fn(),
    listApprovalQueueLineItems: vi.fn(),
    listCaseQueue: vi.fn(),
    listCaseQueueRollup: vi.fn(),
    listAuditEntries: vi.fn(),
    listWithLineItems: vi.fn(),
    approveLineItem: vi.fn(),
    rejectLineItem: vi.fn(),
    clearLineItemFlag: vi.fn(),
    updateLineItemDeductible: vi.fn(),
    issuePayment: vi.fn(),
    voidIssuedPayment: vi.fn(),
    unreconcileSettlement: vi.fn(),
    submitForApReview: vi.fn(),
    transitionStage: vi.fn(),
    recordDeniedTransition: vi.fn(),
    ...overrides
  } as ExpenseReportRepository;
}
