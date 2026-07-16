import { NextFunction, Request, RequestHandler, Response } from "express";
import passport from "passport";
import { ExtractJwt, Strategy as JwtStrategy } from "passport-jwt";

import { UnauthorizedError } from "../errors/problem-json.js";
import { loadJwtRuntimeConfig } from "./tokens.js";

export interface AuthenticatedRequestContext {
  userId: string;
  tenantId: string;
  roles: string[];
}

export type RequestWithAuthContext = Request & {
  authContext?: AuthenticatedRequestContext;
};

interface JwtAuthPayload {
  sub: string;
  tenantId: string;
  roles: string[];
}

let passportConfigured = false;

export function configureJwtPassport(): void {
  if (passportConfigured) {
    return;
  }

  const config = loadJwtRuntimeConfig();

  passport.use(
    "jwt",
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKeyProvider: (_request, _rawJwtToken, done) => {
          try {
            done(null, loadJwtRuntimeConfig().publicKeyPem);
          } catch (error) {
            done(error, undefined);
          }
        },
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256"],
        ignoreExpiration: false
      },
      (payload: unknown, done) => {
        const context = toAuthenticatedContext(payload);

        if (context === null) {
          done(null, false);
          return;
        }

        done(null, context);
      }
    )
  );
  passportConfigured = true;
}

export const requireJwtAuthentication: RequestHandler = (
  request: Request,
  _response: Response,
  next: NextFunction
): void => {
  configureJwtPassport();
  passport.authenticate("jwt", { session: false }, (error: unknown, user: unknown): void => {
    if (error !== null && error !== undefined) {
      next(new UnauthorizedError("Invalid or expired access token."));
      return;
    }

    if (!isAuthenticatedRequestContext(user)) {
      next(new UnauthorizedError("Missing or invalid bearer token."));
      return;
    }

    (request as RequestWithAuthContext).authContext = user;
    next();
  })(request, _response, next);
};

export function requireAuthenticatedContext(
  request: Pick<RequestWithAuthContext, "authContext">
): AuthenticatedRequestContext {
  if (request.authContext === undefined) {
    throw new UnauthorizedError("Missing authenticated request context.");
  }

  return request.authContext;
}

function toAuthenticatedContext(payload: unknown): AuthenticatedRequestContext | null {
  if (!isJwtAuthPayload(payload)) {
    return null;
  }

  return {
    userId: payload.sub,
    tenantId: payload.tenantId,
    roles: payload.roles
  };
}

function isJwtAuthPayload(payload: unknown): payload is JwtAuthPayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  const candidate = payload as Partial<Record<keyof JwtAuthPayload, unknown>>;

  return (
    typeof candidate.sub === "string" &&
    typeof candidate.tenantId === "string" &&
    Array.isArray(candidate.roles) &&
    candidate.roles.every((role) => typeof role === "string")
  );
}

function isAuthenticatedRequestContext(value: unknown): value is AuthenticatedRequestContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Record<keyof AuthenticatedRequestContext, unknown>>;

  return (
    typeof candidate.userId === "string" &&
    typeof candidate.tenantId === "string" &&
    Array.isArray(candidate.roles) &&
    candidate.roles.every((role) => typeof role === "string")
  );
}
