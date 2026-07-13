import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../src/openapi/openapi.js";

type JsonObject = Record<string, unknown>;

describe("generateOpenApiDocument", () => {
  it("generates an OpenAPI 3.1 document for Expense Report routes from Zod schemas", () => {
    const document = expectObject(generateOpenApiDocument());
    const paths = expectObject(document.paths);
    const components = expectObject(document.components);
    const schemas = expectObject(components.schemas);
    const securitySchemes = expectObject(components.securitySchemes);

    const expenseReportsPath = expectObject(paths["/expense-reports"]);
    const createOperation = expectObject(expenseReportsPath.post);
    const createRequestBody = expectObject(createOperation.requestBody);
    const createRequestContent = expectObject(createRequestBody.content);
    const createJsonContent = expectObject(createRequestContent["application/json"]);
    const createRouteSchema = expectObject(createJsonContent.schema);

    const expenseReportByIdPath = expectObject(paths["/expense-reports/{id}"]);
    const readOperation = expectObject(expenseReportByIdPath.get);
    const createResponses = expectObject(createOperation.responses);
    const readResponses = expectObject(readOperation.responses);
    const readSuccess = expectObject(readResponses["200"]);
    const readSuccessContent = expectObject(readSuccess.content);
    const readJsonContent = expectObject(readSuccessContent["application/json"]);
    const readRouteSchema = expectObject(readJsonContent.schema);

    const createSchema = expectObject(schemas.CreateExpenseReportRequest);
    const createProperties = expectObject(createSchema.properties);
    const responseSchema = expectObject(schemas.ExpenseReportResponse);
    const responseProperties = expectObject(responseSchema.properties);

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({
      title: "ExpenseFlow API",
      version: "0.1.0"
    });
    expect(securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT"
    });
    expect(createOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(readOperation.security).toEqual([{ bearerAuth: [] }]);
    expect(createRouteSchema).toEqual({
      $ref: "#/components/schemas/CreateExpenseReportRequest"
    });
    expect(readRouteSchema).toEqual({
      $ref: "#/components/schemas/ExpenseReportResponse"
    });
    expect(Object.keys(createProperties).sort()).toEqual(
      [
        "apReviewerId",
        "assignedOwnerId",
        "createdAt",
        "currentStage",
        "dueDate",
        "holdReason",
        "managerApproverId",
        "onHold",
        "paymentId",
        "priority",
        "updatedAt"
      ].sort()
    );
    expect(createSchema.required).toBeUndefined();
    expect(Object.keys(responseProperties).sort()).toEqual(
      [
        "apReviewerId",
        "assignedOwnerId",
        "createdAt",
        "currentStage",
        "dueDate",
        "holdReason",
        "id",
        "managerApproverId",
        "onHold",
        "paymentId",
        "priority",
        "submitterId",
        "tenantId",
        "updatedAt"
      ].sort()
    );
    expect(responseSchema.required).toEqual([
      "id",
      "tenantId",
      "submitterId",
      "assignedOwnerId",
      "managerApproverId",
      "apReviewerId",
      "paymentId",
      "currentStage",
      "priority",
      "dueDate",
      "onHold",
      "holdReason",
      "createdAt",
      "updatedAt"
    ]);

    expectProblemJsonResponse(createResponses["401"]);
    expectProblemJsonResponse(readResponses["401"]);
    expectProblemJsonResponse(createResponses["429"]);
    expect(readResponses["429"]).toBeUndefined();
    expectRateLimitHeaders(createResponses["429"]);
  });

  it("does not add a hand-written OpenAPI source document beside the generated registry", () => {
    const openApiSourceEntries = readdirSync(join(process.cwd(), "src/openapi"));

    expect(openApiSourceEntries).toEqual(["openapi.ts"]);
  });
});

function expectObject(value: unknown): JsonObject {
  expect(value).toEqual(expect.any(Object));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }

  return value as JsonObject;
}

function expectProblemJsonResponse(value: unknown): void {
  const response = expectObject(value);
  const content = expectObject(response.content);
  const problemJson = expectObject(content["application/problem+json"]);

  expect(problemJson.schema).toEqual({
    $ref: "#/components/schemas/ProblemJson"
  });
}

function expectRateLimitHeaders(value: unknown): void {
  const response = expectObject(value);
  const headers = expectObject(response.headers);

  expect(Object.keys(headers).sort()).toEqual(["RateLimit", "RateLimit-Policy", "Retry-After"]);
  expect(expectObject(headers["Retry-After"]).schema).toMatchObject({
    type: "integer",
    minimum: 0
  });
  expect(expectObject(headers.RateLimit).schema).toEqual({
    type: "string"
  });
  expect(expectObject(headers["RateLimit-Policy"]).schema).toEqual({
    type: "string"
  });
}
