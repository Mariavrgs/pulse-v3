import type { PrismaClient } from "@pulse/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { performCheck, type CheckTarget } from "../checker/http-checker.js";
import {
  DATABASE_URL,
  createDbContext,
  insertServices,
  silentLogger,
  type DbContext,
} from "../test/helpers.js";
import {
  closedPort,
  startConcurrencyProbe,
  startHttpServer,
  type TestServer,
} from "../test/servers.js";
import { KeyedSemaphore } from "./keyed-semaphore.js";
import { createCheckProcessor } from "./process-check.js";

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe.skipIf(!DATABASE_URL)("check processor", () => {
  let ctx: DbContext;
  const servers: TestServer[] = [];

  beforeAll(async () => {
    ctx = await createDbContext();
  });
  afterAll(() => ctx.close());
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    await ctx.prisma.service.deleteMany();
  });

  const serve = async (p: Promise<TestServer>) => {
    const s = await p;
    servers.push(s);
    return s;
  };

  const processor = (over: { prisma?: PrismaClient; now?: () => Date; limit?: number } = {}) =>
    createCheckProcessor({
      prisma: over.prisma ?? ctx.prisma,
      logger: silentLogger(),
      hostLimiter: new KeyedSemaphore(over.limit ?? 5),
      now: over.now ?? (() => T0),
      performCheck: (t: CheckTarget) => performCheck(t, { policy: { allowPrivate: true } }),
    });

  const results = (serviceId: string) =>
    ctx.prisma.checkResult.findMany({ where: { serviceId }, orderBy: { id: "asc" } });

  const job = (serviceId: string, slot: Date = T0) => ({ serviceId, slot: slot.getTime() });

  it("records a healthy check and stamps lastCheckedAt", async () => {
    const s = await serve(startHttpServer((_req, res) => res.end("ok")));
    const [svc] = await insertServices(ctx, 1, { url: s.url });

    expect(await processor()(job(svc?.id as string))).toBe("recorded");

    const [row] = await results(svc?.id as string);
    expect(row).toMatchObject({
      success: true,
      statusCode: 200,
      errorType: null,
      errorMessage: null,
    });
    expect(row?.checkedAt).toEqual(T0);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    const after = await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc?.id as string } });
    expect(after.lastCheckedAt).toEqual(T0);
  });

  it("records HTTP 500 as a failed check and the job still succeeds (no retry for a down target)", async () => {
    const s = await serve(startHttpServer((_req, res) => void res.writeHead(500).end()));
    const [svc] = await insertServices(ctx, 1, { url: s.url });

    await expect(processor()(job(svc?.id as string))).resolves.toBe("recorded");
    const [row] = await results(svc?.id as string);
    expect(row).toMatchObject({ success: false, statusCode: 500, errorType: "UNEXPECTED_STATUS" });
  });

  it("records a timeout and a refused connection as results, not as errors", async () => {
    const slow = await serve(startHttpServer(() => undefined));
    const port = await closedPort();
    const [timeout, refused] = await insertServices(ctx, 2, (i) =>
      i === 0 ? { url: slow.url, timeoutMs: 200 } : { url: `http://127.0.0.1:${port}/` },
    );
    const run = processor();
    await expect(run(job(timeout?.id as string))).resolves.toBe("recorded");
    await expect(run(job(refused?.id as string))).resolves.toBe("recorded");

    expect((await results(timeout?.id as string))[0]).toMatchObject({
      success: false,
      errorType: "TIMEOUT",
    });
    expect((await results(refused?.id as string))[0]).toMatchObject({
      success: false,
      errorType: "CONNECTION",
    });
  });

  it("recovery is visible in the history: a service that was down and comes back", async () => {
    let healthy = false;
    const s = await serve(
      startHttpServer((_req, res) => void res.writeHead(healthy ? 200 : 503).end()),
    );
    const [svc] = await insertServices(ctx, 1, { url: s.url });
    const run = processor();

    await run(job(svc?.id as string));
    await run(job(svc?.id as string));
    healthy = true;
    await run(job(svc?.id as string));

    expect((await results(svc?.id as string)).map((r) => r.success)).toEqual([false, false, true]);
  });

  it("does nothing for a deleted, inactive or stale job", async () => {
    const s = await serve(startHttpServer((_req, res) => res.end("ok")));
    const [inactive, stale] = await insertServices(ctx, 2, (i) => ({
      url: s.url,
      isActive: i !== 0,
      intervalSeconds: 60,
    }));
    const run = processor();

    expect(await run(job("00000000-0000-4000-8000-000000000000"))).toBe("skipped_missing");
    expect(await run(job(inactive?.id as string))).toBe("skipped_inactive");
    expect(await run(job(stale?.id as string, at(-61)))).toBe("skipped_stale"); // waited > one interval
    expect(await run(job(stale?.id as string, at(-59)))).toBe("recorded"); // still fresh

    expect(s.requests).toHaveLength(1); // only the fresh job reached the target
    expect(await results(inactive?.id as string)).toHaveLength(0);
  });

  it("copes with the service being deleted while its check is running", async () => {
    const s = await serve(
      startHttpServer((_req, res) => void setTimeout(() => res.end("ok"), 300)),
    );
    const [svc] = await insertServices(ctx, 1, { url: s.url });

    const pending = processor()(job(svc?.id as string));
    await new Promise((r) => setTimeout(r, 100));
    await ctx.prisma.service.delete({ where: { id: svc?.id as string } });

    await expect(pending).resolves.toBe("skipped_missing");
  });

  it("never moves lastCheckedAt backwards when results arrive out of order", async () => {
    const s = await serve(startHttpServer((_req, res) => res.end("ok")));
    const [svc] = await insertServices(ctx, 1, { url: s.url });

    await processor({ now: () => at(30) })(job(svc?.id as string, at(30)));
    await processor({ now: () => at(10) })(job(svc?.id as string, at(10))); // a late retry of an older slot

    const after = await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc?.id as string } });
    expect(after.lastCheckedAt).toEqual(at(30));
    expect(await results(svc?.id as string)).toHaveLength(2); // both observations are kept
  });

  it("lets database errors escape, so the queue retries them", async () => {
    const s = await serve(startHttpServer((_req, res) => res.end("ok")));
    const [svc] = await insertServices(ctx, 1, { url: s.url });
    const broken = new Proxy(ctx.prisma, {
      get: (target, prop, receiver) =>
        prop === "$transaction"
          ? () => Promise.reject(new Error("database is down"))
          : Reflect.get(target, prop, receiver),
    }) as PrismaClient;

    await expect(processor({ prisma: broken })(job(svc?.id as string))).rejects.toThrow(
      "database is down",
    );
    expect(await results(svc?.id as string)).toHaveLength(0);
  });

  it("limits simultaneous checks against one host", async () => {
    const probe = await startConcurrencyProbe(80);
    servers.push(probe);
    const services = await insertServices(ctx, 8, { url: probe.url });
    const run = processor({ limit: 2 });

    await Promise.all(services.map((s) => run(job(s.id))));

    expect(probe.requests).toHaveLength(8); // everything ran...
    expect(probe.peakInflight()).toBe(2); // ...but never more than 2 at a time
  });
});
