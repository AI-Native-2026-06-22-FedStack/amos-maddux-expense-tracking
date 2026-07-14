import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";
import inject from "light-my-request";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { issueTokenPair } from "../src/auth/tokens.js";

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
    const requestSchema = getJsonContentSchema(expectObject(operation.requestBody));
    const responseSchema = getJsonContentSchema(
      expectObject(expectObject(operation.responses)["201"])
    );
    const validateRequest = createOpenApiValidator(document, requestSchema);
    const validateResponse = createOpenApiValidator(document, responseSchema);
    const requestBody = {
      currentStage: "Drafted",
      priority: "Normal",
      onHold: false
    };

    expect(openApiResponse.statusCode).toBe(200);
    expect(document.servers).toEqual([
      {
        url: "http://localhost:3000/v1"
      }
    ]);
    expect(validateRequest(requestBody)).toBe(true);

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
  });
});

function getPostExpenseReportsOperation(document: JsonObject): JsonObject {
  const paths = expectObject(document.paths);
  const expenseReportsPath = expectObject(paths["/expense-reports"]);

  return expectObject(expenseReportsPath.post);
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
