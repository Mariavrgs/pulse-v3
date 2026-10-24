import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { PrismaClient } from "@pulse/db";
import type { Config, Resolver } from "@pulse/shared";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerErrorHandling } from "./errors.js";
import { createAuthenticate } from "./modules/auth/authenticate.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { AuthService } from "./modules/auth/auth.service.js";
import { TokenService } from "./modules/auth/tokens.js";
import { healthRoutes, type HealthCheck } from "./modules/health/health.routes.js";
import { ServicesRepository } from "./modules/services/services.repository.js";
import { serviceRoutes } from "./modules/services/services.routes.js";
import { ServicesService } from "./modules/services/services.service.js";

export interface AppDeps {
  config: Config;
  prisma: PrismaClient;
  /** Pass `false` to silence logs (tests). Defaults to structured JSON logs at config.LOG_LEVEL. */
  logger?: FastifyServerOptions["logger"];
  /** Injectable DNS resolver for the SSRF policy (tests). */
  resolver?: Resolver;
  /** Injectable clock for token expiry tests. */
  clock?: () => Date;
  /** Extra readiness checks (the database check is always included). */
  healthChecks?: HealthCheck[];
  /** Per-check timeout for the readiness probe. Defaults to 2000ms. */
  healthTimeoutMs?: number;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, prisma } = deps;

  const app = Fastify({
    logger: deps.logger ?? {
      level: config.LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
      },
    },
    // Never trust a client-supplied request id: it ends up in logs and responses.
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandling(app);

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Pulse API",
        version: "0.2.0",
        description: "Availability and performance monitoring for web services.",
      },
      tags: [
        { name: "auth", description: "Accounts and sessions" },
        { name: "services", description: "Monitored services" },
        { name: "health", description: "Probes for this API" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.decorateRequest("userId", "");
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  const clock = deps.clock ?? (() => new Date());
  const tokens = new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS, clock);
  const authenticate = createAuthenticate(tokens);
  const auth = new AuthService({
    prisma,
    tokens,
    refreshTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
    now: clock,
  });
  const services = new ServicesService(new ServicesRepository(prisma), {
    allowPrivate: config.ALLOW_PRIVATE_TARGETS,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  });

  const checks: HealthCheck[] = [
    {
      name: "database",
      run: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    ...(deps.healthChecks ?? []),
  ];

  await app.register(
    healthRoutes({
      checks,
      ...(deps.healthTimeoutMs !== undefined ? { timeoutMs: deps.healthTimeoutMs } : {}),
    }),
    { prefix: "/health" },
  );
  await app.register(
    authRoutes({ auth, authenticate, secureCookies: config.NODE_ENV === "production" }),
    { prefix: "/auth" },
  );
  await app.register(serviceRoutes({ services, authenticate }), { prefix: "/services" });

  return app;
}
