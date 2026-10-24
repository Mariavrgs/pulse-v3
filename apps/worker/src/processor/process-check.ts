import type { PrismaClient } from "@pulse/db";
import type { Logger } from "pino";
import type { CheckOutcome, CheckTarget } from "../checker/http-checker.js";
import type { CheckJobData } from "../queue/check-queue.js";
import type { KeyedSemaphore } from "./keyed-semaphore.js";

export type ProcessOutcome = "recorded" | "skipped_missing" | "skipped_inactive" | "skipped_stale";

export interface ProcessorDeps {
  prisma: PrismaClient;
  performCheck: (target: CheckTarget) => Promise<CheckOutcome>;
  hostLimiter: KeyedSemaphore;
  logger: Logger;
  now?: () => Date;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Handles one job. Returning normally means "this job is done" (including the cases where
 * there was nothing to do); throwing means "retry me" and is reserved for OUR failures, such
 * as the database being unavailable. A target that is down is simply a recorded result.
 */
export function createCheckProcessor(deps: ProcessorDeps) {
  const { prisma, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return async function processCheck(data: CheckJobData): Promise<ProcessOutcome> {
    const service = await prisma.service.findUnique({
      where: { id: data.serviceId },
      select: {
        id: true,
        url: true,
        method: true,
        timeoutMs: true,
        expectedStatusMin: true,
        expectedStatusMax: true,
        intervalSeconds: true,
        isActive: true,
      },
    });
    if (!service) return "skipped_missing";
    if (!service.isActive) return "skipped_inactive";

    // Load shedding: a job that waited longer than one interval is obsolete, the next one is
    // already due. Running it would only add load while the system is already behind.
    const startedAt = now();
    if (startedAt.getTime() - data.slot > service.intervalSeconds * 1000) {
      logger.warn(
        { serviceId: service.id, lagMs: startedAt.getTime() - data.slot },
        "dropping stale check",
      );
      return "skipped_stale";
    }

    const outcome = await deps.hostLimiter.run(hostKey(service.url), () =>
      deps.performCheck({
        url: service.url,
        method: service.method,
        timeoutMs: service.timeoutMs,
        expectedStatusMin: service.expectedStatusMin,
        expectedStatusMax: service.expectedStatusMax,
      }),
    );

    try {
      await prisma.$transaction([
        prisma.checkResult.create({
          data: {
            serviceId: service.id,
            checkedAt: startedAt,
            success: outcome.success,
            statusCode: outcome.statusCode,
            durationMs: outcome.durationMs,
            errorType: outcome.errorType,
            errorMessage: outcome.errorMessage,
          },
        }),
        // Never move lastCheckedAt backwards if results land out of order (retries).
        prisma.service.updateMany({
          where: {
            id: service.id,
            OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: startedAt } }],
          },
          data: { lastCheckedAt: startedAt },
        }),
      ]);
    } catch (err) {
      // The service was deleted while its check was running: nothing left to record.
      if (hasCode(err, "P2003")) return "skipped_missing";
      throw err;
    }
    return "recorded";
  };
}
