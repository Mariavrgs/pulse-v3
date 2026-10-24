import { z } from "zod";

/** Shared by every route so the generated OpenAPI documents the one error shape. */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
