import { Router } from "express";

import { createAuthController } from "../controllers/auth-controller.js";

export function createAuthRouter(): Router {
  const router = Router();
  const authController = createAuthController();

  router.post("/auth/register", authController.register);
  router.post("/auth/login", authController.startLogin);
  router.post("/auth/mfa", authController.completeMfaLogin);

  return router;
}
