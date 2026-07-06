import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../src/openapi/openapi.js";

type JsonObject = Record<string, unknown>;

describe("generateOpenApiDocument", () => {
  it("generates an OpenAPI 3.1 document for Expense Report routes from Zod schemas", () => {
    const document = expectObject(generateOpenApiDocument());
    const paths = expectObject(document.paths);
    const components = expectObject(document.components);
    const schemas = expectObject(components.schemas);

    const expenseReportsPath = expectObject(paths["/expense-reports"]);
    const createOperation = expectObject(expenseReportsPath.post);
    const createRequestBody = expectObject(createOperation.requestBody);
    const createRequestContent = expectObject(createRequestBody.content);
    const createJsonContent = expectObject(createRequestContent["application/json"]);
    const createRouteSchema = expectObject(createJsonContent.schema);

    const expenseReportByIdPath = expectObject(paths["/expense-reports/{id}"]);
    const readOperation = expectObject(expenseReportByIdPath.get);
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
        "submitterId",
        "tenantId",
        "updatedAt"
      ].sort()
    );
    expect(createSchema.required).toEqual(["tenantId", "submitterId"]);
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
  });
});

function expectObject(value: unknown): JsonObject {
  expect(value).toEqual(expect.any(Object));

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }

  return value as JsonObject;
}
