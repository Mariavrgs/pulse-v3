import { TargetRejectedError } from "@pulse/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";

/** An error the client is allowed to see. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const unauthenticated = (message = "Authentication required") =>
  new AppError(401, "UNAUTHENTICATED", message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const validationError = (details: unknown) =>
  new AppError(400, "VALIDATION_ERROR", "Request validation failed", details);

function errorBody(requestId: string, code: string, message: string, details?: unknown) {
  return {
    error: { code, message, ...(details !== undefined ? { details } : {}), requestId },
  };
}

function toPath(instancePath: string): string {
  const path = instancePath.replace(/^\//, "").replaceAll("/", ".");
  return path === "" ? "(root)" : path;
}

const GENERIC_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
};

/**
 * Every failure leaves the API in the same shape:
 *   { error: { code, message, details?, requestId } }
 * Unexpected errors are logged with full detail and returned without any.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(errorBody(request.id, "NOT_FOUND", "Route not found")),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(errorBody(request.id, error.code, error.message, error.details));
    }

    if (error instanceof TargetRejectedError) {
      // `detail` may contain internal addresses: logs only, never the response.
      request.log.warn({ reason: error.code, detail: error.detail }, "monitoring target rejected");
      return reply
        .status(422)
        .send(errorBody(request.id, "URL_NOT_ALLOWED", error.message, { reason: error.code }));
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((v) => ({
        in: error.validationContext ?? "request",
        path: toPath(v.instancePath),
        message: v.message ?? "Invalid value",
      }));
      return reply
        .status(400)
        .send(errorBody(request.id, "VALIDATION_ERROR", "Request validation failed", details));
    }

    const status = error.statusCode;
    if (
      !isResponseSerializationError(error) &&
      status !== undefined &&
      status >= 400 &&
      status < 500
    ) {
      return reply
        .status(status)
        .send(errorBody(request.id, GENERIC_CODES[status] ?? "BAD_REQUEST", error.message));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(errorBody(request.id, "INTERNAL_ERROR", "Internal server error"));
  });
}
