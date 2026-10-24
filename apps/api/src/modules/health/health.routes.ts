import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export interface HealthCheck {
  name: string;
  run(): Promise<void>;
}

const CheckResult = z.object({ status: z.enum(["up", "down"]), latencyMs: z.number() });
const ReadyResponse = z.object({
  status: z.enum(["ok", "unavailable"]),
  checks: z.record(z.string(), CheckResult),
});

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function healthRoutes(deps: {
  checks: HealthCheck[];
  timeoutMs?: number;
}): FastifyPluginAsync {
  const timeoutMs = deps.timeoutMs ?? 2000;

  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    // Liveness: the process is up and the event loop answers. It must not touch dependencies,
    // otherwise a database blip would make an orchestrator restart a healthy process.
    app.get(
      "/live",
      {
        schema: {
          tags: ["health"],
          summary: "Liveness probe",
          response: { 200: z.object({ status: z.literal("ok") }) },
        },
      },
      async () => ({ status: "ok" as const }),
    );

    // Readiness: can this instance serve traffic right now? Failure details go to the logs;
    // the response only says up or down.
    app.get(
      "/ready",
      {
        schema: {
          tags: ["health"],
          summary: "Readiness probe",
          response: { 200: ReadyResponse, 503: ReadyResponse },
        },
      },
      async (request, reply) => {
        const results = await Promise.all(
          deps.checks.map(async (check) => {
            const started = performance.now();
            try {
              await withTimeout(check.run(), timeoutMs);
              return [
                check.name,
                { status: "up" as const, latencyMs: Math.round(performance.now() - started) },
              ] as const;
            } catch (err) {
              request.log.error({ err, check: check.name }, "readiness check failed");
              return [
                check.name,
                { status: "down" as const, latencyMs: Math.round(performance.now() - started) },
              ] as const;
            }
          }),
        );
        const healthy = results.every(([, r]) => r.status === "up");
        return reply
          .status(healthy ? 200 : 503)
          .send({ status: healthy ? "ok" : "unavailable", checks: Object.fromEntries(results) });
      },
    );
  };
}
