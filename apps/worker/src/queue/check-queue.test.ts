import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Scheduler } from "../scheduler/scheduler.js";
import {
  DATABASE_URL,
  REDIS_URL,
  createDbContext,
  createRedis,
  destroyQueue,
  insertServices,
  silentLogger,
  uniqueQueueName,
  type DbContext,
} from "../test/helpers.js";
import { createBullCheckQueue, jobIdFor, type CheckQueue } from "./check-queue.js";

describe("jobIdFor", () => {
  it("is deterministic and avoids the character BullMQ forbids", () => {
    const data = { serviceId: "4f2c6f5e-8d0a-4c55-9d39-1d1a2f8b7c11", slot: 1780315200000 };
    expect(jobIdFor(data)).toBe(jobIdFor({ ...data }));
    expect(jobIdFor(data)).not.toContain(":");
    expect(jobIdFor(data)).not.toBe(jobIdFor({ ...data, slot: data.slot + 1 }));
  });
});

describe.skipIf(!REDIS_URL)("BullMQ check queue (real Redis)", () => {
  let redis: Redis;
  const names: string[] = [];
  const queues: CheckQueue[] = [];

  beforeAll(() => {
    redis = createRedis();
  });
  afterAll(() => {
    redis.disconnect();
  });
  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close()));
    await Promise.all(names.splice(0).map((n) => destroyQueue(redis, n)));
  });

  const open = () => {
    const name = uniqueQueueName();
    names.push(name);
    const queue = createBullCheckQueue(redis, name);
    queues.push(queue);
    return queue;
  };
  const job = (n: number) => ({
    serviceId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    slot: 1000,
  });

  it("counts waiting jobs", async () => {
    const queue = open();
    expect(await queue.waitingCount()).toBe(0);
    await queue.enqueue([job(1), job(2), job(3)]);
    expect(await queue.waitingCount()).toBe(3);
  });

  it("ignores a job whose id already exists (idempotent enqueue)", async () => {
    const queue = open();
    await queue.enqueue([job(1), job(1)]);
    await queue.enqueue([job(1)]);
    expect(await queue.waitingCount()).toBe(1);
  });

  it("accepts an empty batch", async () => {
    const queue = open();
    await expect(queue.enqueue([])).resolves.toBeUndefined();
  });

  describe.skipIf(!DATABASE_URL)("scheduler backpressure against the real queue", () => {
    let ctx: DbContext;
    beforeAll(async () => {
      ctx = await createDbContext();
    });
    afterAll(() => ctx.close());

    it("stops claiming once the queue holds maxQueueDepth jobs", async () => {
      const queue = open();
      await queue.enqueue([job(1), job(2), job(3), job(4), job(5)]); // nobody consumes them
      await insertServices(ctx, 3, { nextCheckAt: new Date(Date.now() - 1000) });

      const scheduler = new Scheduler({
        prisma: ctx.prisma,
        queue,
        logger: silentLogger(),
        intervalMs: 50,
        batchSize: 10,
        maxQueueDepth: 5,
      });
      expect(await scheduler.tick()).toMatchObject({ claimed: 0, backpressure: true });
      expect(await queue.waitingCount()).toBe(5);
    });
  });
});
