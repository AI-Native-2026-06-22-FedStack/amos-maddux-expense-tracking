import type { RequestHandler } from "express";

import { getApiRuntimeConfig } from "./runtime-config.js";

export const apiCorsAllowedMethods = ["GET", "POST", "PATCH", "OPTIONS"] as const;
export const apiCorsAllowedHeaders = [
  "Authorization",
  "Content-Type",
  "X-Correlation-Id",
  "Idempotency-Key"
] as const;

interface CreateApiCorsMiddlewareOptions {
  allowedOrigin?: string;
}

export function createApiCorsMiddleware(
  options: CreateApiCorsMiddlewareOptions = {}
): RequestHandler {
  const allowedOrigin = options.allowedOrigin ?? getApiRuntimeConfig().API_CORS_ALLOWED_ORIGIN;
  const allowedMethods = apiCorsAllowedMethods.join(",");
  const allowedHeaders = apiCorsAllowedHeaders.join(",");

  return (request, response, next) => {
    if (request.headers.origin === allowedOrigin) {
      response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", allowedMethods);
      response.setHeader("Access-Control-Allow-Headers", allowedHeaders);
    }

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  };
}
