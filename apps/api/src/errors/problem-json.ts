import { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

interface ProblemJsonBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

export class NotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export const problemJsonErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const problem = toProblemJson(error, request.originalUrl);

  response.type("application/problem+json").status(problem.status).json(problem);
};

function toProblemJson(error: unknown, instance: string): ProblemJsonBody {
  if (error instanceof ZodError) {
    return {
      type: "/problems/request-validation",
      title: "Bad Request",
      status: 400,
      detail: formatZodDetail(error),
      instance
    };
  }

  if (error instanceof NotFoundError) {
    return {
      type: "/problems/not-found",
      title: "Not Found",
      status: 404,
      detail: error.message,
      instance
    };
  }

  if (error instanceof UnauthorizedError) {
    return {
      type: "/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: error.message,
      instance
    };
  }

  return {
    type: "/problems/internal-server-error",
    title: "Internal Server Error",
    status: 500,
    detail: "An unexpected server error occurred.",
    instance
  };
}

function formatZodDetail(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "request";

      return `${field}: ${issue.message}`;
    })
    .join("; ");
}
