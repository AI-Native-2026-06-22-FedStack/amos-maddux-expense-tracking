import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi
} from "@asteasolutions/zod-to-openapi";
import type { HeadersObject } from "openapi3-ts/oas31";
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

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT"
});

const problemJsonContent = {
  "application/problem+json": {
    schema: problemJsonOpenApiSchema
  }
};
const rateLimitResponseHeaders: HeadersObject = {
  "Retry-After": {
    description: "Seconds to wait before retrying after the write limit is exceeded.",
    schema: {
      type: "integer",
      minimum: 0
    }
  },
  RateLimit: {
    description: "Draft-8 rate limit service limit for the Expense Report write policy.",
    schema: {
      type: "string"
    }
  },
  "RateLimit-Policy": {
    description: "Draft-8 rate limit policy for Expense Report writes.",
    schema: {
      type: "string"
    }
  }
};

registry.registerPath({
  method: "post",
  path: "/expense-reports",
  summary: "Create an Expense Report",
  description: "Open a Drafted Expense Report from a minimal validated request.",
  security: [{ bearerAuth: [] }],
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
        ...problemJsonContent
      }
    },
    401: {
      description: "Missing or invalid bearer token.",
      content: {
        ...problemJsonContent
      }
    },
    429: {
      description: "Expense Report write rate limit exceeded.",
      headers: rateLimitResponseHeaders,
      content: {
        ...problemJsonContent
      }
    }
  }
});

registry.registerPath({
  method: "get",
  path: "/expense-reports/{id}",
  summary: "Read an Expense Report",
  description: "Read an Expense Report by its validated id.",
  security: [{ bearerAuth: [] }],
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
        ...problemJsonContent
      }
    },
    401: {
      description: "Missing or invalid bearer token.",
      content: {
        ...problemJsonContent
      }
    },
    404: {
      description: "Expense Report not found.",
      content: {
        ...problemJsonContent
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
