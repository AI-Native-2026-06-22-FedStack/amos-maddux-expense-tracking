import express, { RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import { apiReference } from "@scalar/express-api-reference";

import { NotFoundError, problemJsonErrorHandler } from "./errors/problem-json.js";
import { generateOpenApiDocument } from "./openapi/openapi.js";
import { createExpenseReportRouter } from "./routes/expense-report-routes.js";
import { createHealthRouter } from "./routes/health-routes.js";

export function createApp(): express.Express {
  const app = express();

  app.use(express.json());
  app.use(pinoHttp());

  app.get("/openapi.json", (_request, response) => {
    response.json(generateOpenApiDocument());
  });
  app.get("/docs", apiReference({ url: "/openapi.json" }));

  app.use(createHealthRouter());
  app.use(createExpenseReportRouter());

  app.use(notFoundHandler);
  app.use(problemJsonErrorHandler);

  return app;
}

const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new NotFoundError("Route not found."));
};
