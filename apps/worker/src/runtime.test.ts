import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  DATABASE_URL,
  REDIS_URL,
  createDbContext,
  createRedis,
  destroyQueue,
  insertServices,
  silentLogger,
  testConfig,
  uniqueQueueName,
  type DbContext,
} from "./test/helpers.js";
import {
  startConcurrencyProbe,
  startHttpServer,
  waitFor,
  type TestServer,
} from "./test/servers.js";
import type { PrismaClient } from "@pulse/db";
import { startWorkerRuntime, type WorkerRuntime } from "./runtime.js";

describe.skipIf(!DATABASE_URL || !REDIS_URL)(
  "worker runtime (scheduler + BullMQ + processor)",
  () => {
    let ctx: DbContext;
    let redis: Redis;

    const servers: TestServer[] = [];
    const runtimes: WorkerRuntime[] = [];
    const queueNames: string[] = [];

    beforeAll(async () => {
      ctx = await createDbContext();
      redis = createRedis();
    });
    afterAll(async () => {
      await ctx.close();
      redis.disconnect();
    });
    afterEach(async () => {
      await Promise.all(runtimes.splice(0).map((r) => r.stop()));
      await Promise.all(servers.splice(0).map((s) => s.close()));
      await Promise.all(queueNames.splice(0).map((n) => destroyQueue(redis, n)));
      await ctx.prisma.service.deleteMany();
    });

    const serve = async <T extends TestServer>(p: Promise<T>) => {
      const s = await p;
      servers.push(s);
      return s;
    };

    function start(
      opts: {
        env?: Record<string, string>;
        prisma?: PrismaClient;
        startScheduler?: boolean;
      } = {},
    ) {
      const queueName = uniqueQueueName();
      queueNames.push(queueName);
      const runtime = startWorkerRuntime({
        config: testConfig(ctx.db.url, opts.env),
        prisma: opts.prisma ?? ctx.prisma,
        redis,
        logger: silentLogger(),
        queueName,
        startScheduler: opts.startScheduler ?? true,
      });
      runtimes.push(runtime);
      return { runtime, queueName };
    }

    const resultCount = (serviceId: string) =>
      ctx.prisma.checkResult.count({ where: { serviceId } });
    const waitForResults = (serviceIds: string[], each = 1) =>
      waitFor(
        async () => {
          const counts = await Promise.all(serviceIds.map(resultCount));
          return counts.every((c) => c >= each) ? counts : false;
        },
        { timeoutMs: 15000 },
      );

    it("end to end: a due service gets checked and its result recorded, with no manual step", async () => {
      const target = await serve(startHttpServer((_req, res) => res.end("ok")));
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      start();

      await waitForResults([svc?.id as string]);
      const row = await ctx.prisma.checkResult.findFirstOrThrow({
        where: { serviceId: svc?.id as string },
      });
      expect(row).toMatchObject({ success: true, statusCode: 200 });

      const after = await ctx.prisma.service.findUniqueOrThrow({
        where: { id: svc?.id as string },
      });
      expect(after.lastCheckedAt).not.toBeNull();
      expect(after.nextCheckAt.getTime()).toBeGreaterThan(Date.now()); // scheduled for the next interval
    });

    it("checks many services exactly once each", async () => {
      const target = await serve(startHttpServer((_req, res) => res.end("ok")));
      const services = await insertServices(ctx, 40, {
        url: target.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      start({ env: { WORKER_CONCURRENCY: "10", WORKER_PER_HOST_CONCURRENCY: "10" } });

      await waitForResults(services.map((s) => s.id));
      await new Promise((r) => setTimeout(r, 300)); // give any duplicate time to show up
      const total = await ctx.prisma.checkResult.count();
      expect(total).toBe(40);
      expect(target.requests).toHaveLength(40);
    });

    it("deduplicates: the same service and slot enqueued repeatedly produces one check", async () => {
      const target = await serve(startHttpServer((_req, res) => res.end("ok")));
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        nextCheckAt: new Date(Date.now() + 3_600_000),
      });
      const { runtime } = start({ startScheduler: false });

      const data = { serviceId: svc?.id as string, slot: Date.now() };
      await runtime.queue.enqueue([data, data]);
      await runtime.queue.enqueue([data]);

      await waitForResults([svc?.id as string]);
      await new Promise((r) => setTimeout(r, 400));
      expect(await resultCount(svc?.id as string)).toBe(1);
    });

    it("a failing target is a recorded result and does not fail or retry the job", async () => {
      const target = await serve(startHttpServer((_req, res) => void res.writeHead(500).end()));
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      const { queueName } = start();

      await waitForResults([svc?.id as string]);
      const inspector = new Queue(queueName, { connection: redis });
      try {
        await waitFor(async () => (await inspector.getCompletedCount()) === 1);
        expect(await inspector.getFailedCount()).toBe(0);
        expect(target.requests).toHaveLength(1); // checked once, not retried
      } finally {
        await inspector.close();
      }
      const row = await ctx.prisma.checkResult.findFirstOrThrow({
        where: { serviceId: svc?.id as string },
      });
      expect(row).toMatchObject({
        success: false,
        errorType: "UNEXPECTED_STATUS",
        statusCode: 500,
      });
    });

    it("retries with backoff when WE fail (database error), and records exactly one result", async () => {
      const target = await serve(startHttpServer((_req, res) => res.end("ok")));
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        nextCheckAt: new Date(Date.now() - 100),
      });

      let transactionCalls = 0;
      const flaky = new Proxy(ctx.prisma, {
        get: (target, prop, receiver) =>
          prop === "$transaction"
            ? (...args: unknown[]) => {
                transactionCalls++;
                if (transactionCalls === 1) return Promise.reject(new Error("connection lost"));
                return (target.$transaction as (...a: unknown[]) => unknown)(...args);
              }
            : Reflect.get(target, prop, receiver),
      }) as PrismaClient;
      start({ prisma: flaky });

      await waitForResults([svc?.id as string]); // arrives after the ~2s backoff
      expect(transactionCalls).toBe(2);
      expect(await resultCount(svc?.id as string)).toBe(1);
    }, 20000);

    it("never runs more checks at once than WORKER_CONCURRENCY", async () => {
      const probe = await serve(startConcurrencyProbe(150));
      const services = await insertServices(ctx, 12, {
        url: probe.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      start({ env: { WORKER_CONCURRENCY: "3", WORKER_PER_HOST_CONCURRENCY: "50" } });

      await waitForResults(services.map((s) => s.id));
      expect(probe.requests).toHaveLength(12);
      expect(probe.peakInflight()).toBeLessThanOrEqual(3);
      expect(probe.peakInflight()).toBeGreaterThan(1); // and it did run in parallel
    });

    it("never runs more checks against one host than WORKER_PER_HOST_CONCURRENCY", async () => {
      const probe = await serve(startConcurrencyProbe(150));
      const services = await insertServices(ctx, 10, {
        url: probe.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      start({ env: { WORKER_CONCURRENCY: "10", WORKER_PER_HOST_CONCURRENCY: "2" } });

      await waitForResults(services.map((s) => s.id));
      expect(probe.requests).toHaveLength(10);
      expect(probe.peakInflight()).toBe(2);
    });

    it("drops a job that waited longer than one interval instead of running it late", async () => {
      const target = await serve(startHttpServer((_req, res) => res.end("ok")));
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        intervalSeconds: 60,
        nextCheckAt: new Date(Date.now() + 3_600_000),
      });
      const { runtime, queueName } = start({ startScheduler: false });

      await runtime.queue.enqueue([
        { serviceId: svc?.id as string, slot: Date.now() - 10 * 60_000 },
      ]);

      const inspector = new Queue(queueName, { connection: redis });
      try {
        await waitFor(async () => (await inspector.getCompletedCount()) === 1);
      } finally {
        await inspector.close();
      }
      expect(target.requests).toHaveLength(0);
      expect(await resultCount(svc?.id as string)).toBe(0);
    });

    it("shuts down gracefully: a check in flight finishes and is recorded before stop() returns", async () => {
      const target = await serve(
        startHttpServer((_req, res) => void setTimeout(() => res.end("ok"), 600)),
      );
      const [svc] = await insertServices(ctx, 1, {
        url: target.url,
        nextCheckAt: new Date(Date.now() - 100),
      });
      const { runtime } = start();

      await waitFor(() => target.requests.length === 1); // the check is now in flight
      await runtime.stop();

      expect(await resultCount(svc?.id as string)).toBe(1);
    });
  },
);
