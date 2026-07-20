import { resolve } from "node:path";

import { MatchersV3, PactV4 } from "@pact-foundation/pact";
import { describe, expect, it, vi } from "vitest";

import { createGlCodingEngineClient } from "../src/engine/gl-client.js";
import type { ExpenseReportRepository } from "../src/repository/expense-report-repository.js";
import { createExpenseReportService } from "../src/services/expense-report-service.js";
import { makeExpenseReport } from "./factories/make-expense-report.js";

const { boolean, equal, like, regex } = MatchersV3;

const consumerName = "ExpenseFlow Core Case Service";
const providerName = "ExpenseFlow Domain Compute GL Coding";

const tenantId = "00000000-0000-4000-8000-000000000501";
const reportId = "00000000-0000-4000-8000-000000000502";
const actorId = "synthetic-user-00000000-0000-4000-8000-000000000503";
const lineItemId = "00000000-0000-4000-8000-000000000504";
const bearerToken = "synthetic-forwarded-token";

const pact = new PactV4({
  consumer: consumerName,
  provider: providerName,
  dir: resolve(import.meta.dirname, "../../../pacts"),
  logLevel: "warn"
});

describe("Core Case Service GL-coding consumer pact", () => {
  it("submits an over-500 Expense Report line item and records the flagged response path", async () => {
    const report = makeExpenseReport({ id: reportId, tenantId, currentStage: "Drafted" });
    const submittedReport = { ...report, currentStage: "AP Review" as const };
    const repository = makeRepository({
      findForSubmit: vi.fn(async () => ({
        ...report,
        lineItems: [
          {
            id: lineItemId,
            tenant_id: tenantId,
            expense_report_id: reportId,
            merchant: "Synthetic Merchant",
            amount_cents: 50001,
            currency: "USD",
            category: "Meals",
            flagged: false,
            flag_cleared: false,
            deductible: false,
            created_at: new Date("2026-07-17T12:00:00.000Z")
          }
        ],
        mileageEntries: []
      })),
      submitForApReview: vi.fn(async () => submittedReport)
    });

    await pact
      .addInteraction()
      .given("a tenant has a valid Meals GL-coding category")
      .uponReceiving("a Core submit request asks Compute to code an over-500 Expense Report")
      .withRequest("POST", "/v1/coding", (builder) => {
        builder
          .headers({
            authorization: regex("Bearer [A-Za-z0-9._-]+", `Bearer ${bearerToken}`),
            "content-type": "application/json"
          })
          .jsonBody({
            line_items: [
              {
                line_item_id: regex(uuidPattern, lineItemId),
                amount: regex(moneyPattern, "500.01"),
                currency: equal("USD"),
                category: equal("Meals")
              }
            ],
            mileage_entries: []
          });
      })
      .willRespondWith(200, (builder) => {
        builder.headers({ "content-type": "application/json" }).jsonBody({
          coded_line_items: [
            {
              status: equal("unmapped"),
              line_item_id: regex(uuidPattern, lineItemId),
              category: equal("Meals"),
              unmapped_marker: equal("UNMAPPED_GL_CATEGORY"),
              flagged: boolean(true)
            }
          ],
          coded_mileage_entries: [],
          flagged_line_item: like(lineItemId)
        });
      })
      .executeTest(async (mockServer) => {
        const glCodingEngineClient = createGlCodingEngineClient({
          baseUrl: mockServer.url,
          maxAttempts: 1
        });
        const service = createExpenseReportService(repository, glCodingEngineClient);

        await expect(
          service.submitForApReview({
            expenseReportId: reportId,
            tenantId,
            actorId,
            bearerToken
          })
        ).resolves.toMatchObject({ currentStage: "AP Review" });

        expect(repository.submitForApReview).toHaveBeenCalledWith({
          expenseReportId: reportId,
          tenantId,
          actorId,
          flaggedLineItemIds: [lineItemId]
        });
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
    ...overrides
  } as ExpenseReportRepository;
}

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const moneyPattern = "^(?!0+(\\.0{1,2})?$)[0-9]{1,10}(\\.[0-9]{1,2})?$";
