import express, { RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { apiReference } from "@scalar/express-api-reference";
import type { Logger } from "pino";

import { NotFoundError, problemJsonErrorHandler } from "./errors/problem-json.js";
import { logger as rootLogger } from "./logger.js";
import { bindCorrelationId, CORRELATION_ID_LOG_FIELD } from "./middleware/correlation.js";
import { generateOpenApiDocument } from "./openapi/openapi.js";
import { createAuthRouter } from "./routes/auth-routes.js";
import { createExpenseReportRouter } from "./routes/expense-report-routes.js";
import { createHealthRouter } from "./routes/health-routes.js";

interface CreateAppOptions {
  logger?: Logger;
  expenseWriteRateLimiters?: readonly RequestHandler[];
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
  app.use(express.json());

  app.get("/openapi.json", (_request, response) => {
    response.json(generateOpenApiDocument());
  });
  app.get("/docs", apiReference({ url: "/openapi.json" }));

  app.use(createHealthRouter());
  app.use(createAuthRouter());
  app.use(
    createExpenseReportRouter({
      expenseWriteRateLimiters: options.expenseWriteRateLimiters
    })
  );

  app.use(notFoundHandler);
  app.use(problemJsonErrorHandler);

  return app;
}

const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new NotFoundError("Route not found."));
};
