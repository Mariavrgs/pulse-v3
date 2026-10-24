import type { PrismaClient } from "@pulse/db";
import type { Config, Resolver } from "@pulse/shared";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { performCheck } from "./checker/http-checker.js";
import { KeyedSemaphore } from "./processor/keyed-semaphore.js";
import { createCheckProcessor } from "./processor/process-check.js";
import {
  CHECK_QUEUE_NAME,
  createBullCheckQueue,
  createBullCheckWorker,
  type CheckQueue,
} from "./queue/check-queue.js";
import { Scheduler } from "./scheduler/scheduler.js";

export interface RuntimeOptions {
  config: Config;
  prisma: PrismaClient;
  /** Must be created with `maxRetriesPerRequest: null` (BullMQ requirement for workers). */
  redis: Redis;
  logger: Logger;
  queueName?: string;
  /** Test seams. */
  resolver?: Resolver;
  now?: () => Date;
  startScheduler?: boolean;
}

export interface WorkerRuntime {
  scheduler: Scheduler;
  queue: CheckQueue;
  /** Graceful: stops claiming, lets running checks finish, then closes the queue. */
  stop(): Promise<void>;
}

export function startWorkerRuntime(opts: RuntimeOptions): WorkerRuntime {
  const { config, prisma, redis, logger } = opts;
  const queueName = opts.queueName ?? CHECK_QUEUE_NAME;

  const queue = createBullCheckQueue(redis, queueName);
  const hostLimiter = new KeyedSemaphore(config.WORKER_PER_HOST_CONCURRENCY);

  const processCheck = createCheckProcessor({
    prisma,
    logger,
    hostLimiter,
    ...(opts.now ? { now: opts.now } : {}),
    performCheck: (target) =>
      performCheck(target, {
        policy: {
          allowPrivate: config.ALLOW_PRIVATE_TARGETS,
          ...(opts.resolver ? { resolver: opts.resolver } : {}),
        },
        onUnexpectedError: (err) => logger.error({ err }, "unclassified error during check"),
      }),
  });

  const worker = createBullCheckWorker(redis, processCheck, {
    name: queueName,
    concurrency: config.WORKER_CONCURRENCY,
  });
  worker.on("failed", (job, err) =>
    logger.error(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
      "check job failed (will retry if attempts remain)",
    ),
  );
  worker.on("error", (err) => logger.error({ err }, "worker error"));

  const scheduler = new Scheduler({
    prisma,
    queue,
    logger,
    intervalMs: config.SCHEDULER_INTERVAL_MS,
    batchSize: config.SCHEDULER_BATCH_SIZE,
    maxQueueDepth: config.MAX_QUEUE_DEPTH,
    ...(opts.now ? { now: opts.now } : {}),
  });
  if (opts.startScheduler ?? true) scheduler.start();

  return {
    scheduler,
    queue,
    async stop() {
      await scheduler.stop(); // no new claims
      await worker.close(); // waits for checks in flight
      await queue.close();
    },
  };
}
