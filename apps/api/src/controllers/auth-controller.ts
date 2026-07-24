import { z } from "zod";

import { AuthService, createAuthService } from "../auth/auth-service.js";
import { UnauthorizedError } from "../errors/problem-json.js";

const registerRequestSchema = z.object({
  tenantId: z.uuid(),
  roleId: z.uuid(),
  email: z.email(),
  displayName: z.string().min(1),
  password: z.string().min(1)
});

const startLoginRequestSchema = z.object({
  tenantId: z.uuid(),
  email: z.email(),
  password: z.string().min(1)
});

const completeMfaLoginRequestSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  code: z.string().regex(/^\d{6}$/u)
});

const refreshSessionRequestSchema = z.object({
  tenantId: z.uuid(),
  userId: z.uuid(),
  refreshToken: z.string().min(1)
});

interface JsonResponse {
  status(code: number): {
    json(body: unknown): void;
  };
}

export class AuthController {
  public constructor(private readonly authService: AuthService = createAuthService()) {}

  public register = async (request: { body: unknown }, response: JsonResponse): Promise<void> => {
    const parsedRequest = registerRequestSchema.parse(request.body);
    const result = await this.authService.register(parsedRequest);

    response.status(201).json(result);
  };

  public startLogin = async (request: { body: unknown }, response: JsonResponse): Promise<void> => {
    const parsedRequest = startLoginRequestSchema.parse(request.body);
    const result = await this.authService.startLogin(parsedRequest);

    if (result.status === "unauthorized") {
      throw new UnauthorizedError(result.message);
    }

    response.status(200).json(result);
  };

  public completeMfaLogin = async (
    request: { body: unknown },
    response: JsonResponse
  ): Promise<void> => {
    const parsedRequest = completeMfaLoginRequestSchema.parse(request.body);
    const result = await this.authService.completeMfaLogin(parsedRequest);

    if (result.status === "unauthorized") {
      throw new UnauthorizedError(result.message);
    }

    response.status(200).json(result);
  };

  public refreshSession = async (
    request: { body: unknown },
    response: JsonResponse
  ): Promise<void> => {
    const parsedRequest = refreshSessionRequestSchema.parse(request.body);
    const result = await this.authService.refreshSession(parsedRequest);

    if (result.status === "unauthorized") {
      throw new UnauthorizedError(result.message);
    }

    response.status(200).json(result);
  };
}

export function createAuthController(): AuthController {
  return new AuthController();
}
