import express, { RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { apiReference } from "@scalar/express-api-reference";
import type { Logger } from "pino";

import { ExpenseReportController } from "./controllers/expense-report-controller.js";
import { NotFoundError, problemJsonErrorHandler } from "./errors/problem-json.js";
import { logger as rootLogger } from "./logger.js";
import { bindCorrelationId, CORRELATION_ID_LOG_FIELD } from "./middleware/correlation.js";
import { attachAiAssistUsageHeader } from "./middleware/cost-header.js";
import { generateOpenApiDocument } from "./openapi/openapi.js";
import { createApiCorsMiddleware } from "./config/cors.js";
import { createAuthRouter } from "./routes/auth-routes.js";
import { createExpenseReportRouter } from "./routes/expense-report-routes.js";
import { createHealthRouter } from "./routes/health-routes.js";

const API_VERSION_PREFIX = "/v1";
const LEGACY_API_DEPRECATION_DATE = "@1783987200";
const LEGACY_API_SUNSET_DATE = "Mon, 12 Oct 2026 00:00:00 GMT";

interface CreateAppOptions {
  logger?: Logger;
  expenseWriteRateLimiters?: readonly RequestHandler[];
  expenseReportIdempotencyMiddleware?: RequestHandler;
  expenseReportController?: ExpenseReportController;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const logger = options.logger ?? rootLogger;

  app.use(
    pinoHttp({
      logger,
      customProps(request) {
        if (typeof request.correlationId !== "string") {
          return {};
        }

        return {
          [CORRELATION_ID_LOG_FIELD]: request.correlationId
        };
      }
    })
  );
  app.use(bindCorrelationId);
  app.use(attachAiAssistUsageHeader);
  app.use(createApiCorsMiddleware());
  app.use(express.json());

  app.get("/openapi.json", (_request, response) => {
    response.json(generateOpenApiDocument());
  });
  app.get("/docs", apiReference({ url: "/openapi.json" }));

  app.use(createHealthRouter());

  const createExpenseReportRoutes = () =>
    createExpenseReportRouter({
      expenseWriteRateLimiters: options.expenseWriteRateLimiters,
      expenseReportIdempotencyMiddleware: options.expenseReportIdempotencyMiddleware,
      expenseReportController: options.expenseReportController
    });

  const v1Router = express.Router();
  v1Router.use(createAuthRouter());
  v1Router.use(createExpenseReportRoutes());
  app.use(API_VERSION_PREFIX, v1Router);

  app.use(["/auth", "/expense-reports"], legacyApiDeprecationHeaders);
  app.use(createAuthRouter());
  app.use(createExpenseReportRoutes());

  app.use(notFoundHandler);
  app.use(problemJsonErrorHandler);

  return app;
}

const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new NotFoundError("Route not found."));
};

const legacyApiDeprecationHeaders: RequestHandler = (request, response, next) => {
  const legacyPath = request.originalUrl.split("?")[0] ?? request.path;

  response.setHeader("Deprecation", LEGACY_API_DEPRECATION_DATE);
  response.setHeader("Sunset", LEGACY_API_SUNSET_DATE);
  response.setHeader("Link", `<${API_VERSION_PREFIX}${legacyPath}>; rel="successor-version"`);
  next();
};
