import { createRequire } from "node:module";

import { Ajv2020 } from "ajv/dist/2020.js";

import { BoundaryContractError } from "../errors/problem-json.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as typeof import("ajv-formats").default;
const glCodingContractSchema =
  require("@expenseflow/shared-schemas/gl-coding.schema.json") as GlCodingContractSchema;

type JsonObject = Record<string, unknown>;

interface GlCodingContractSchema extends JsonObject {
  $schema?: string;
  $defs: {
    GlCodingRequest: JsonObject;
    GlCodingResponse: JsonObject;
  };
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});
addFormats(ajv);

const validateRequestSchema = ajv.compile({
  $schema: glCodingContractSchema.$schema,
  ...glCodingContractSchema.$defs.GlCodingRequest,
  $defs: glCodingContractSchema.$defs
});

const validateResponseSchema = ajv.compile({
  $schema: glCodingContractSchema.$schema,
  ...glCodingContractSchema.$defs.GlCodingResponse,
  $defs: glCodingContractSchema.$defs
});

export function validateGlCodingRequestPayload(payload: unknown): void {
  if (!validateRequestSchema(payload)) {
    throw new BoundaryContractError("GL coding request does not match the shared schema.");
  }
}

export function validateGlCodingResponsePayload(payload: unknown): void {
  if (!validateResponseSchema(payload)) {
    throw new BoundaryContractError("GL coding response does not match the shared schema.");
  }
}

export function getGlCodingContractPackageName(): string {
  return "@expenseflow/shared-schemas";
}
