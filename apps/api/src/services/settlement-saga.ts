import { randomUUID } from "node:crypto";

import type {
  ExpenseReportRepository,
  TransitionStageRequest
} from "../repository/expense-report-repository.js";
import type { ExpenseReportResponse } from "../schemas/expense-report.schema.js";

export interface SettlementSaga {
  settle(request: SettlementSagaRequest): Promise<ExpenseReportResponse>;
}

export interface SettlementSagaRequest {
  expenseReportId: string;
  tenantId: string;
  actorId: string;
  correlationId: string;
  reason?: string;
}

export interface PaymentStub {
  issuePayment(request: IssuePaymentStubRequest): Promise<IssuedPayment>;
  voidPayment(request: VoidPaymentStubRequest): Promise<void>;
}

export interface IssuePaymentStubRequest {
  expenseReportId: string;
  tenantId: string;
  idempotencyKey: string;
}

export interface VoidPaymentStubRequest {
  paymentId: string;
}

export interface IssuedPayment {
  id: string;
}

type CompletedSagaStep = {
  name: string;
  compensate(): Promise<void>;
};

class OrchestratedSettlementSaga implements SettlementSaga {
  public constructor(
    private readonly repository: ExpenseReportRepository,
    private readonly paymentStub: PaymentStub
  ) {}

  public async settle(request: SettlementSagaRequest): Promise<ExpenseReportResponse> {
    const completedSteps: CompletedSagaStep[] = [];

    try {
      const issuedPayment = await this.paymentStub.issuePayment({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        idempotencyKey: request.correlationId
      });
      let paymentRecorded = false;
      completedSteps.push({
        name: "issue-payment",
        compensate: async () => {
          await this.paymentStub.voidPayment({ paymentId: issuedPayment.id });

          if (paymentRecorded) {
            await this.repository.voidIssuedPayment({
              expenseReportId: request.expenseReportId,
              tenantId: request.tenantId,
              actorId: request.actorId,
              paymentId: issuedPayment.id,
              reason: "Settlement saga compensation voided the issued payment."
            });
          }
        }
      });

      await this.repository.issuePayment({
        expenseReportId: request.expenseReportId,
        tenantId: request.tenantId,
        actorId: request.actorId,
        paymentId: issuedPayment.id
      });
      paymentRecorded = true;

      const reconciledReport = await this.repository.transitionStage(
        toReconcileTransitionRequest(request)
      );
      completedSteps.push({
        name: "reconcile",
        compensate: () =>
          this.repository.unreconcileSettlement({
            expenseReportId: request.expenseReportId,
            tenantId: request.tenantId,
            actorId: request.actorId,
            correlationId: request.correlationId,
            reason: "Settlement saga compensation restored the Expense Report to Paid."
          })
      });

      return reconciledReport;
    } catch (error) {
      await compensateCompletedSteps(completedSteps);
      throw error;
    }
  }
}

class SyntheticPaymentStub implements PaymentStub {
  private readonly issuedPaymentIdsByKey = new Map<string, string>();
  private readonly voidedPaymentIds = new Set<string>();

  public constructor(private readonly createId: () => string = randomUUID) {}

  public async issuePayment(request: IssuePaymentStubRequest): Promise<IssuedPayment> {
    const existingPaymentId = this.issuedPaymentIdsByKey.get(request.idempotencyKey);
    if (existingPaymentId !== undefined) {
      return { id: existingPaymentId };
    }

    const id = `synthetic-payment-${this.createId()}`;
    this.issuedPaymentIdsByKey.set(request.idempotencyKey, id);

    return {
      id
    };
  }

  public async voidPayment(request: VoidPaymentStubRequest): Promise<void> {
    this.voidedPaymentIds.add(request.paymentId);
  }
}

export function createSettlementSaga(
  repository: ExpenseReportRepository,
  paymentStub: PaymentStub = new SyntheticPaymentStub()
): SettlementSaga {
  return new OrchestratedSettlementSaga(repository, paymentStub);
}

async function compensateCompletedSteps(completedSteps: CompletedSagaStep[]): Promise<void> {
  for (const step of [...completedSteps].reverse()) {
    await step.compensate();
  }
}

function toReconcileTransitionRequest(request: SettlementSagaRequest): TransitionStageRequest {
  return {
    expenseReportId: request.expenseReportId,
    tenantId: request.tenantId,
    actorId: request.actorId,
    fromStage: "Paid",
    toStage: "Reconciled",
    correlationId: request.correlationId,
    reason: request.reason ?? "Expense Report settlement reconciled.",
    action: "Expense Report Reconciled"
  };
}
