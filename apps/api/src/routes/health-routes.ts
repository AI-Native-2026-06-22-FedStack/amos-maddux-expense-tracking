import { Router } from "express";

import { createHealthController } from "../controllers/health-controller.js";

export function createHealthRouter(): Router {
  const router = Router();
  const healthController = createHealthController();

  router.get("/health", healthController.getStatus);
  router.get("/ready", healthController.getReadiness);
  router.get("/health/error", healthController.throwForErrorHandler);

  return router;
}
