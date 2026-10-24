import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@pulse/db/testing";
import { parseConfig, type Config } from "@pulse/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import type { CheckJobData, CheckQueue } from "../queue/check-queue.js";

export const DATABASE_URL = process.env.DATABASE_URL;
export const REDIS_URL = process.env.REDIS_URL;

export const silentLogger = () => pino({ level: "silent" });

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Config {
  return parseConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: REDIS_URL ?? "redis://localhost:6379",
    JWT_SECRET: "a-test-secret-with-at-least-32-characters!!",
    NODE_ENV: "test",
    ALLOW_PRIVATE_TARGETS: "true", // checks target local test servers
    SCHEDULER_INTERVAL_MS: "100",
    ...overrides,
  });
}

export interface DbContext {
  db: TestDatabase;
  prisma: TestDatabase["prisma"];
  ownerId: string;
  close(): Promise<void>;
}

export async function createDbContext(): Promise<DbContext> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = await createTestDatabase(DATABASE_URL);
  const owner = await db.prisma.user.create({
    data: { email: `${randomUUID()}@example.com`, passwordHash: "x" },
  });
  return { db, prisma: db.prisma, ownerId: owner.id, close: () => db.close() };
}

type ServiceOverrides = Partial<{
  url: string;
  nextCheckAt: Date;
  isActive: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  method: "GET" | "HEAD";
  expectedStatusMin: number;
  expectedStatusMax: number;
}>;

export async function insertServices(
  ctx: Pick<DbContext, "prisma" | "ownerId">,
  count: number,
  overrides: ServiceOverrides | ((index: number) => ServiceOverrides) = {},
) {
  return ctx.prisma.service.createManyAndReturn({
    data: Array.from({ length: count }, (_, i) => ({
      ownerId: ctx.ownerId,
      name: `svc-${i}`,
      url: "http://127.0.0.1:9/",
      ...(typeof overrides === "function" ? overrides(i) : overrides),
    })),
  });
}

/** In-memory queue for testing the scheduler without Redis. */
export class FakeQueue implements CheckQueue {
  jobs: CheckJobData[] = [];
  batches: CheckJobData[][] = [];
  waiting = 0;
  failNext = false;

  async enqueue(jobs: readonly CheckJobData[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("redis is down");
    }
    this.batches.push([...jobs]);
    this.jobs.push(...jobs);
  }
  async waitingCount(): Promise<number> {
    return this.waiting;
  }
  async close(): Promise<void> {}
}

export function createRedis(): Redis {
  if (!REDIS_URL) throw new Error("REDIS_URL is required");
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  redis.on("error", () => undefined); // surfaced through the failing operation instead
  return redis;
}

/** Removes a test queue's keys from Redis. */
export async function destroyQueue(redis: Redis, name: string): Promise<void> {
  const queue = new Queue(name, { connection: redis });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

export const uniqueQueueName = () => `test-checks-${randomUUID()}`;
