import { z } from "zod";
import { crossFieldIssues } from "./rules.js";

const fields = {
  name: z.string().trim().min(1).max(100),
  url: z.string().min(1).max(2048).describe("Absolute http(s) URL of the endpoint to monitor"),
  method: z.enum(["GET", "HEAD"]),
  expectedStatusMin: z.int().min(100).max(599),
  expectedStatusMax: z.int().min(100).max(599),
  intervalSeconds: z.int().min(10).max(86400),
  timeoutMs: z.int().min(100).max(60000),
  degradedLatencyMs: z.int().positive().max(60000).nullable(),
  failureThreshold: z.int().min(1).max(20),
  recoveryThreshold: z.int().min(1).max(20),
  degradedThreshold: z.int().min(1).max(20),
  isActive: z.boolean(),
};

/**
 * strictObject rejects unknown keys, so a client cannot smuggle in ownerId, status,
 * counters or any other server-managed column (mass assignment).
 */
export const CreateServiceBody = z
  .strictObject({
    name: fields.name,
    url: fields.url,
    method: fields.method.default("GET"),
    expectedStatusMin: fields.expectedStatusMin.default(200),
    expectedStatusMax: fields.expectedStatusMax.default(299),
    intervalSeconds: fields.intervalSeconds.default(60),
    timeoutMs: fields.timeoutMs.default(10000),
    degradedLatencyMs: fields.degradedLatencyMs.default(null),
    failureThreshold: fields.failureThreshold.default(3),
    recoveryThreshold: fields.recoveryThreshold.default(2),
    degradedThreshold: fields.degradedThreshold.default(3),
    isActive: fields.isActive.default(true),
  })
  .superRefine((value, ctx) => {
    for (const issue of crossFieldIssues(value)) {
      ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
    }
  });

export const UpdateServiceBody = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required" });

export const IdParams = z.object({ id: z.uuid() });

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ServiceDto = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  method: z.enum(["GET", "HEAD"]),
  expectedStatusMin: z.number(),
  expectedStatusMax: z.number(),
  intervalSeconds: z.number(),
  timeoutMs: z.number(),
  degradedLatencyMs: z.number().nullable(),
  failureThreshold: z.number(),
  recoveryThreshold: z.number(),
  degradedThreshold: z.number(),
  isActive: z.boolean(),
  status: z.enum(["UNKNOWN", "UP", "DEGRADED", "DOWN"]),
  lastCheckedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ServiceListResponse = z.object({
  items: z.array(ServiceDto),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type CreateServiceInput = z.infer<typeof CreateServiceBody>;
export type UpdateServiceInput = z.infer<typeof UpdateServiceBody>;
