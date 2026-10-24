import type { Service } from "@pulse/db";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponse as E } from "../../schemas.js";
import {
  CreateServiceBody,
  IdParams,
  ListQuery,
  ServiceDto,
  ServiceListResponse,
  UpdateServiceBody,
} from "./schemas.js";
import type { ServicesService } from "./services.service.js";

export interface ServiceRoutesDeps {
  services: ServicesService;
  authenticate: (request: FastifyRequest) => Promise<void>;
}

/** Explicit allowlist of public fields: ownerId and future internal columns never leak. */
export function toServiceDto(s: Service): z.infer<typeof ServiceDto> {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    method: s.method,
    expectedStatusMin: s.expectedStatusMin,
    expectedStatusMax: s.expectedStatusMax,
    intervalSeconds: s.intervalSeconds,
    timeoutMs: s.timeoutMs,
    degradedLatencyMs: s.degradedLatencyMs,
    failureThreshold: s.failureThreshold,
    recoveryThreshold: s.recoveryThreshold,
    degradedThreshold: s.degradedThreshold,
    isActive: s.isActive,
    status: s.status,
    lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const security = [{ bearerAuth: [] }];

export function serviceRoutes(deps: ServiceRoutesDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();
    app.addHook("onRequest", deps.authenticate);

    app.post(
      "",
      {
        schema: {
          tags: ["services"],
          summary: "Register a service to monitor",
          description:
            "The URL is validated against the SSRF policy (scheme, port, DNS resolution, private and metadata address ranges) before anything is stored.",
          security,
          body: CreateServiceBody,
          response: { 201: ServiceDto, 400: E, 401: E, 422: E },
        },
      },
      async (request, reply) => {
        const created = await deps.services.create(request.userId, request.body);
        return reply.status(201).send(toServiceDto(created));
      },
    );

    app.get(
      "",
      {
        schema: {
          tags: ["services"],
          summary: "List your services",
          security,
          querystring: ListQuery,
          response: { 200: ServiceListResponse, 400: E, 401: E },
        },
      },
      async (request) => {
        const { limit, offset } = request.query;
        const { items, total } = await deps.services.list(request.userId, limit, offset);
        return { items: items.map(toServiceDto), total, limit, offset };
      },
    );

    app.get(
      "/:id",
      {
        schema: {
          tags: ["services"],
          summary: "Get one service",
          security,
          params: IdParams,
          response: { 200: ServiceDto, 400: E, 401: E, 404: E },
        },
      },
      async (request) => toServiceDto(await deps.services.get(request.userId, request.params.id)),
    );

    app.patch(
      "/:id",
      {
        schema: {
          tags: ["services"],
          summary: "Update a service",
          security,
          params: IdParams,
          body: UpdateServiceBody,
          response: { 200: ServiceDto, 400: E, 401: E, 404: E, 422: E },
        },
      },
      async (request) =>
        toServiceDto(await deps.services.update(request.userId, request.params.id, request.body)),
    );

    app.delete(
      "/:id",
      {
        schema: {
          tags: ["services"],
          summary: "Delete a service and its history",
          security,
          params: IdParams,
          response: { 204: z.null(), 400: E, 401: E, 404: E },
        },
      },
      async (request, reply) => {
        await deps.services.remove(request.userId, request.params.id);
        return reply.status(204).send(null);
      },
    );
  };
}
