import { NextFunction, Request, Response } from "express";

import { HealthService, createHealthService } from "../services/health-service.js";

interface JsonResponse {
  status(code: number): {
    json(body: unknown): void;
  };
}

export class HealthController {
  public constructor(private readonly healthService: HealthService = createHealthService()) {}

  public getStatus = (_request: Request, response: Response): void => {
    response.status(200).json(this.healthService.readStatus());
  };

  public getReadiness = async (
    request: Pick<Request, "correlationId">,
    response: JsonResponse
  ): Promise<void> => {
    const readiness = await this.healthService.readReadiness({
      correlationId: request.correlationId
    });
    const statusCode = readiness.status === "ready" ? 200 : 503;

    response.status(statusCode).json(readiness);
  };

  public throwForErrorHandler = (
    request: Request,
    response: Response,
    next: NextFunction
  ): void => {
    void request;
    void response;
    void next;

    this.healthService.throwSyntheticFailure();
  };
}

export function createHealthController(): HealthController {
  return new HealthController();
}
