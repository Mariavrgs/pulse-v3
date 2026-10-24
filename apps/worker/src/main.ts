import { createPrismaClient } from "@pulse/db";
import { ConfigError, loadConfig } from "@pulse/shared";
import { Redis } from "ioredis";
import pino from "pino";
import { startWorkerRuntime } from "./runtime.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = pino({ level: config.LOG_LEVEL });
const prisma = createPrismaClient(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (err: Error) => logger.error({ err }, "redis connection error"));

const runtime = startWorkerRuntime({ config, prisma, redis, logger });
logger.info(
  {
    concurrency: config.WORKER_CONCURRENCY,
    perHostConcurrency: config.WORKER_PER_HOST_CONCURRENCY,
    schedulerIntervalMs: config.SCHEDULER_INTERVAL_MS,
    batchSize: config.SCHEDULER_BATCH_SIZE,
    maxQueueDepth: config.MAX_QUEUE_DEPTH,
  },
  "worker started",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  try {
    await runtime.stop();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during shutdown");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
