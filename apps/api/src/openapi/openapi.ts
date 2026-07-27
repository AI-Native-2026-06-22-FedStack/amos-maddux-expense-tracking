import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi
} from "@asteasolutions/zod-to-openapi";
import type { HeadersObject } from "openapi3-ts/oas31";
import { z } from "zod";

extendZodWithOpenApi(z);

const { caseQueueRollupResponseSchema, expenseReportIdParamSchema, expenseReportResponseSchema } =
  await import("../schemas/expense-report.schema.js");

const registry = new OpenAPIRegistry();

registry.registerComponent("schemas", "CreateExpenseReportRequest", {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        draftType: { const: "mileage", type: "string" },
        dueDate: { format: "date", type: "string" },
        mileageEntries: {
          items: {
            additionalProperties: false,
            properties: {
              business_purpose: { maxLength: 500, minLength: 1, type: "string" },
              destination: { maxLength: 200, minLength: 1, type: "string" },
              miles: { exclusiveMinimum: 0, type: "number" },
              origin: { maxLength: 200, minLength: 1, type: "string" },
              trip_date: { format: "date", type: "string" }
            },
            required: ["business_purpose", "destination", "miles", "origin", "trip_date"],
            type: "object"
          },
          minItems: 1,
          type: "array"
        },
        priority: { enum: ["Low", "Normal", "High", "Urgent"], type: "string" }
      },
      required: ["draftType", "mileageEntries", "priority"],
      type: "object"
    },
    {
      additionalProperties: false,
      properties: {
        draftType: { const: "expense", type: "string" },
        dueDate: { format: "date", type: "string" },
        lineItems: {
          items: {
            additionalProperties: false,
            properties: {
              amount_cents: { exclusiveMinimum: 0, type: "integer" },
              category: { maxLength: 100, minLength: 1, type: "string" },
              currency: { pattern: "^[A-Z]{3}$", type: "string" },
              merchant: { maxLength: 200, minLength: 1, type: "string" },
              receipt: {
                additionalProperties: false,
                properties: {
                  amount_cents: { exclusiveMinimum: 0, type: "integer" },
                  currency: { pattern: "^[A-Z]{3}$", type: "string" },
                  merchant: { maxLength: 200, minLength: 1, type: "string" },
                  receipt_date: { format: "date", type: "string" },
                  receipt_number: { maxLength: 100, minLength: 1, type: "string" }
                },
                required: ["amount_cents", "currency", "merchant", "receipt_date"],
                type: "object"
              }
            },
            required: ["amount_cents", "category", "currency", "merchant", "receipt"],
            type: "object"
          },
          minItems: 1,
          type: "array"
        },
        priority: { enum: ["Low", "Normal", "High", "Urgent"], type: "string" }
      },
      required: ["draftType", "lineItems", "priority"],
      type: "object"
    }
  ]
});
const createExpenseReportRequestOpenApiSchema = {
  $ref: "#/components/schemas/CreateExpenseReportRequest"
};
const expenseReportIdParamOpenApiSchema = registry.register(
  "ExpenseReportIdParam",
  expenseReportIdParamSchema
);
const expenseReportResponseOpenApiSchema = registry.register(
  "ExpenseReportResponse",
  expenseReportResponseSchema
);
const caseQueueRollupResponseOpenApiSchema = registry.register(
  "CaseQueueRollupResponse",
  caseQueueRollupResponseSchema
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
const aiAssistUsageResponseHeader: HeadersObject = {
  "AI-Assist-Usage": {
    description: "AI-assist cost indicator and remaining tenant quota for this request.",
    schema: {
      type: "string"
    }
  }
};
const rateLimitResponseHeaders: HeadersObject = {
  ...aiAssistUsageResponseHeader,
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
      headers: aiAssistUsageResponseHeader,
      content: {
        "application/json": {
          schema: expenseReportResponseOpenApiSchema
        }
      }
    },
    400: {
      description: "Request validation failed.",
      headers: aiAssistUsageResponseHeader,
      content: {
        ...problemJsonContent
      }
    },
    401: {
      description: "Missing or invalid bearer token.",
      headers: aiAssistUsageResponseHeader,
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
  path: "/expense-reports/case-queue/rollup",
  summary: "Read Finance Dashboard rollup",
  description:
    "Read tenant-scoped Expense Report stage counts and overdue counts for internal dashboard roles.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Expense Report rollup found.",
      headers: aiAssistUsageResponseHeader,
      content: {
        "application/json": {
          schema: caseQueueRollupResponseOpenApiSchema
        }
      }
    },
    401: {
      description: "Missing or invalid bearer token.",
      headers: aiAssistUsageResponseHeader,
      content: {
        ...problemJsonContent
      }
    },
    403: {
      description: "Authenticated role cannot read internal dashboard rollups.",
      headers: aiAssistUsageResponseHeader,
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
      headers: aiAssistUsageResponseHeader,
      content: {
        "application/json": {
          schema: expenseReportResponseOpenApiSchema
        }
      }
    },
    400: {
      description: "Request validation failed.",
      headers: aiAssistUsageResponseHeader,
      content: {
        ...problemJsonContent
      }
    },
    401: {
      description: "Missing or invalid bearer token.",
      headers: aiAssistUsageResponseHeader,
      content: {
        ...problemJsonContent
      }
    },
    404: {
      description: "Expense Report not found.",
      headers: aiAssistUsageResponseHeader,
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
        url: "http://localhost:3000/v1"
      }
    ]
  });
}
