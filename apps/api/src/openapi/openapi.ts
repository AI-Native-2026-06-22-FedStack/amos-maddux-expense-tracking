import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

const {
  createExpenseReportRequestSchema,
  expenseReportIdParamSchema,
  expenseReportResponseSchema
} = await import("../schemas/expense-report.schema.js");

const registry = new OpenAPIRegistry();

const createExpenseReportRequestOpenApiSchema = registry.register(
  "CreateExpenseReportRequest",
  createExpenseReportRequestSchema
);
const expenseReportIdParamOpenApiSchema = registry.register(
  "ExpenseReportIdParam",
  expenseReportIdParamSchema
);
const expenseReportResponseOpenApiSchema = registry.register(
  "ExpenseReportResponse",
  expenseReportResponseSchema
);
const problemJsonOpenApiSchema = registry.register(
  "ProblemJson",
  z.object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string()
  })
);

registry.registerPath({
  method: "post",
  path: "/expense-reports",
  summary: "Create an Expense Report",
  description: "Open a Drafted Expense Report from a minimal validated request.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: createExpenseReportRequestOpenApiSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Drafted Expense Report created.",
      content: {
        "application/json": {
          schema: expenseReportResponseOpenApiSchema
        }
      }
    },
    400: {
      description: "Request validation failed.",
      content: {
        "application/problem+json": {
          schema: problemJsonOpenApiSchema
        }
      }
    }
  }
});

registry.registerPath({
  method: "get",
  path: "/expense-reports/{id}",
  summary: "Read an Expense Report",
  description: "Read an Expense Report by its validated id.",
  request: {
    params: expenseReportIdParamOpenApiSchema
  },
  responses: {
    200: {
      description: "Expense Report found.",
      content: {
        "application/json": {
          schema: expenseReportResponseOpenApiSchema
        }
      }
    },
    400: {
      description: "Request validation failed.",
      content: {
        "application/problem+json": {
          schema: problemJsonOpenApiSchema
        }
      }
    },
    404: {
      description: "Expense Report not found.",
      content: {
        "application/problem+json": {
          schema: problemJsonOpenApiSchema
        }
      }
    }
  }
});

export function generateOpenApiDocument(): ReturnType<OpenApiGeneratorV31["generateDocument"]> {
  const generator = new OpenApiGeneratorV31(registry.definitions);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "ExpenseFlow API",
      version: "0.1.0"
    },
    servers: [
      {
        url: "http://localhost:3000"
      }
    ]
  });
}
