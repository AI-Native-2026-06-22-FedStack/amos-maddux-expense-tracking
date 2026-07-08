import { NextFunction, Request, Response } from "express";

import { HealthService, createHealthService } from "../services/health-service.js";

export class HealthController {
  public constructor(private readonly healthService: HealthService = createHealthService()) {}

  public getStatus = (_request: Request, response: Response): void => {
    response.status(200).json(this.healthService.readStatus());
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
