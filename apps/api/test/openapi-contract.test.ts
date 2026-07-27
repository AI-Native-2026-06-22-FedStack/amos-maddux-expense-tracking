import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { issueTokenPair } from "../src/auth/tokens.js";
import { createExpenseReportRequestSchema } from "../src/schemas/expense-report.schema.js";

type JsonObject = Record<string, unknown>;

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;

const tenantId = "00000000-0000-4000-8000-000000000701";
const userId = "synthetic-user-00000000-0000-4000-8000-000000000702";

describe("served OpenAPI contract", () => {
  it("matches the served POST /v1/expense-reports request and response shape", async () => {
    const app = createApp();
    const openApiResponse = await inject(app, {
      method: "GET",
      url: "/openapi.json"
    });
    const document = expectObject(openApiResponse.json());
    const operation = getPostExpenseReportsOperation(document);
    const rollupOperation = getCaseQueueRollupOperation(document);
    const requestSchema = getJsonContentSchema(expectObject(operation.requestBody));
    const responseSchema = getJsonContentSchema(
      expectObject(expectObject(operation.responses)["201"])
    );
    const rollupResponseSchema = getJsonContentSchema(
      expectObject(expectObject(rollupOperation.responses)["200"])
    );
    const validateRequest = createOpenApiValidator(document, requestSchema);
    const validateResponse = createOpenApiValidator(document, responseSchema);
    const validateRollupResponse = createOpenApiValidator(document, rollupResponseSchema);
    const requestBody = {
      draftType: "mileage",
      mileageEntries: [
        {
          business_purpose: "Synthetic client support visit.",
          destination: "Synthetic Destination Office",
          miles: 18.25,
          origin: "Synthetic Origin Office",
          trip_date: "2026-08-01"
        }
      ],
      priority: "Normal"
    };

    expect(openApiResponse.statusCode).toBe(200);
    expect(document.servers).toEqual([
      {
        url: "http://localhost:3000/v1"
      }
    ]);
    expect(validateRequest(requestBody)).toBe(true);
    expect(
      validateRequest({
        ...requestBody,
        currentStage: "Submitted"
      })
    ).toBe(false);
    expectOpenApiAndSharedCreateRequestToAgree(validateRequest);

    const createResponse = await inject(app, {
      method: "POST",
      url: "/v1/expense-reports",
      headers: {
        authorization: createAuthorizationHeader()
      },
      payload: requestBody
    });
    const createdReport = createResponse.json();

    expect(createResponse.statusCode).toBe(201);
    expect(validateResponse(createdReport)).toBe(true);

    const driftedResponse = expectObject(structuredClone(createdReport));
    delete driftedResponse.id;

    expect(validateResponse(driftedResponse)).toBe(false);

    const responseWithUnexpectedField = {
      ...createdReport,
      unexpectedField: "synthetic-schema-drift"
    };

    expect(validateResponse(responseWithUnexpectedField)).toBe(false);
    expect(
      validateRollupResponse({
        summaries: [
          { stage: "Drafted", reportCount: 2, overdueCount: 1 },
          { stage: "Submitted", reportCount: 0, overdueCount: 0 }
        ]
      })
    ).toBe(true);
    expect(
      validateRollupResponse({
        summaries: [{ stage: "Archived", reportCount: 1, overdueCount: 0 }]
      })
    ).toBe(false);
  });
});

function expectOpenApiAndSharedCreateRequestToAgree(
  validateRequest: ReturnType<typeof createOpenApiValidator>
): void {
  const cases: readonly unknown[] = [
    {
      draftType: "mileage",
      mileageEntries: [
        {
          business_purpose: "Synthetic client support visit.",
          destination: "Synthetic Destination Office",
          miles: 18.25,
          origin: "Synthetic Origin Office",
          trip_date: "2026-08-01"
        }
      ]
    },
    {
      draftType: "expense",
      lineItems: [
        {
          amount_cents: 4250,
          category: "Meals",
          currency: "USD",
          merchant: "Synthetic Cafe",
          receipt: {
            amount_cents: 4250,
            currency: "USD",
            merchant: "Synthetic Cafe",
            receipt_date: "2026-08-02"
          }
        }
      ],
      priority: "High"
    },
    {
      draftType: "mileage",
      mileageEntries: [],
      priority: "Normal"
    },
    {
      draftType: "expense",
      lineItems: [
        {
          amount_cents: 4250,
          category: "Meals",
          currency: "usd",
          merchant: "Synthetic Cafe",
          receipt: {
            amount_cents: 4250,
            currency: "USD",
            merchant: "Synthetic Cafe",
            receipt_date: "2026-08-02"
          }
        }
      ]
    },
    {
      currentStage: "Submitted",
      draftType: "mileage",
      mileageEntries: [
        {
          business_purpose: "Synthetic client support visit.",
          destination: "Synthetic Destination Office",
          miles: 18.25,
          origin: "Synthetic Origin Office",
          trip_date: "2026-08-01"
        }
      ]
    }
  ];

  for (const body of cases) {
    expect(validateRequest(body)).toBe(createExpenseReportRequestSchema.safeParse(body).success);
  }
}

function getPostExpenseReportsOperation(document: JsonObject): JsonObject {
  const paths = expectObject(document.paths);
  const expenseReportsPath = expectObject(paths["/expense-reports"]);

  return expectObject(expenseReportsPath.post);
}

function getCaseQueueRollupOperation(document: JsonObject): JsonObject {
  const paths = expectObject(document.paths);
  const rollupPath = expectObject(paths["/expense-reports/case-queue/rollup"]);

  return expectObject(rollupPath.get);
}

function getJsonContentSchema(container: JsonObject): JsonObject {
  const content = expectObject(container.content);
  const jsonContent = expectObject(content["application/json"]);

  return expectObject(jsonContent.schema);
}

function createOpenApiValidator(document: JsonObject, schema: JsonObject) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false
  });
  addFormats(ajv);

  return ajv.compile({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schema,
    components: document.components
  });
}

function expectObject(value: unknown): JsonObject {
  expect(value).toEqual(expect.any(Object));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }

  return value as JsonObject;
}

function createAuthorizationHeader(): string {
  const tokenPair = issueTokenPair({
    tenantId,
    userId,
    roles: ["Employee"]
  });

  return `Bearer ${tokenPair.accessToken}`;
}
