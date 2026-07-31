import express, { type NextFunction, type Request, type Response } from "express";

import {
  TaxpayerStatusNotFoundError,
  type ExpenseFlowTaxpayerVerificationGateway,
  type TaxIdentifierType,
  type TaxpayerStandingResult,
  type TaxpayerVerificationResult
} from "./index.js";

export function createTivsAclApp(gateway: ExpenseFlowTaxpayerVerificationGateway) {
  const app = express();

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.post("/v1/taxpayer-verifications", async (request, response, next) => {
    try {
      const body = parseVerificationRequest(request);
      const result = await gateway.verifyTaxpayer(body);

      response.status(200).json(toVerificationJson(result));
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/taxpayer-status", async (request, response, next) => {
    try {
      const body = parseStandingRequest(request);
      const result = await gateway.getTaxpayerStanding(body);

      response.status(200).json(toStandingJson(result));
    } catch (error) {
      next(error);
    }
  });

  app.use(errorHandler);

  return app;
}

function parseVerificationRequest(request: Request) {
  const body = parseRecordBody(request.body);

  return {
    correlationId: readCorrelationId(request),
    legalName: readRequiredString(body, "legalName"),
    taxIdentifier: readRequiredString(body, "taxIdentifier"),
    taxIdentifierType: readTaxIdentifierType(body)
  };
}

function parseStandingRequest(request: Request) {
  const body = parseRecordBody(request.body);

  return {
    correlationId: readCorrelationId(request),
    taxIdentifier: readRequiredString(body, "taxIdentifier"),
    taxIdentifierType: readTaxIdentifierType(body)
  };
}

function toVerificationJson(result: TaxpayerVerificationResult) {
  return {
    matched: result.matched,
    reason: result.reason,
    ...(result.registeredName === undefined ? {} : { registeredName: result.registeredName }),
    taxIdentifierType: result.taxIdentifierType
  };
}

function toStandingJson(result: TaxpayerStandingResult) {
  return {
    asOf: result.asOf.toISOString(),
    standing: result.standing,
    taxIdentifierType: result.taxIdentifierType
  };
}

function parseRecordBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON object.");
  }

  return body as Record<string, unknown>;
}

function readRequiredString(body: Record<string, unknown>, fieldName: string): string {
  const value = body[fieldName];

  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${fieldName} is required.`);
  }

  return value;
}

function readTaxIdentifierType(body: Record<string, unknown>): TaxIdentifierType {
  const value = body.taxIdentifierType;

  if (value !== "ein" && value !== "ssn") {
    throw new BadRequestError("taxIdentifierType must be ein or ssn.");
  }

  return value;
}

function readCorrelationId(request: Request): string {
  const value = request.header("x-correlation-id");

  return value === undefined || value.trim() === "" ? "missing-correlation-id" : value;
}

function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
): void {
  if (error instanceof BadRequestError) {
    response.status(400).json({
      type: "https://expenseflow.example.test/problems/bad-request",
      title: "Bad Request",
      status: 400,
      detail: error.message
    });
    return;
  }

  if (error instanceof TaxpayerStatusNotFoundError) {
    response.status(404).json({
      type: "https://expenseflow.example.test/problems/taxpayer-status-not-found",
      title: "Taxpayer Status Not Found",
      status: 404,
      detail: error.message,
      code: error.kind,
      taxIdentifier: error.redactedTaxIdentifier
    });
    return;
  }

  response.status(503).json({
    type: "https://expenseflow.example.test/problems/tivs-unavailable",
    title: "TIVS Unavailable",
    status: 503,
    detail: "Taxpayer verification is temporarily unavailable."
  });
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
