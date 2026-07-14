import "express-serve-static-core";

import type { AuthenticatedRequestContext } from "../auth/verifier.js";
import type { AiAssistUsage } from "../middleware/cost-header.js";

declare module "express-serve-static-core" {
  interface Request {
    aiAssistUsage?: AiAssistUsage;
    authContext?: AuthenticatedRequestContext;
    correlationId: string;
  }
}
