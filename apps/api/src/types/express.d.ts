import "express-serve-static-core";

import type { AuthenticatedRequestContext } from "../auth/verifier.js";

declare module "express-serve-static-core" {
  interface Request {
    authContext?: AuthenticatedRequestContext;
    correlationId: string;
  }
}
