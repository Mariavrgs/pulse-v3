import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../test/servers.js";
import {
  DATABASE_URL,
  FakeQueue,
  createDbContext,
  insertServices,
  silentLogger,
  type DbContext,
} from "../test/helpers.js";
import { Scheduler } from "./scheduler.js";

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe.skipIf(!DATABASE_URL)("Scheduler", () => {
  let ctx: DbContext;
  beforeAll(async () => {
    ctx = await createDbContext();
  });
  afterAll(() => ctx.close());

  const reset = () => ctx.prisma.service.deleteMany();
  const make = (queue: FakeQueue, over: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) =>
    new Scheduler({
      prisma: ctx.prisma,
      queue,
      logger: silentLogger(),
      intervalMs: 20,
      batchSize: 100,
      maxQueueDepth: 1000,
      now: () => T0,
      ...over,
    });

  it("enqueues one job per due service with its service id and due slot", async () => {
    await reset();
    const [a, b] = await insertServices(ctx, 2, (i) => ({ nextCheckAt: at(-10 - i) }));
    const queue = new FakeQueue();
    const result = await make(queue).tick();

    expect(result).toMatchObject({ claimed: 2, backpressure: false, maxLagMs: 11000 });
    expect(queue.jobs).toEqual(
      expect.arrayContaining([
        { serviceId: a?.id, slot: at(-10).getTime() },
        { serviceId: b?.id, slot: at(-11).getTime() },
      ]),
    );
  });

  it("drains a large backlog in batches within one tick", async () => {
    await reset();
    await insertServices(ctx, 250, { nextCheckAt: at(-5) });
    const queue = new FakeQueue();
    const result = await make(queue, { batchSize: 100 }).tick();
    expect(result.claimed).toBe(250);
    expect(queue.batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("caps the work of a single tick and leaves the rest for the next one", async () => {
    await reset();
    await insertServices(ctx, 250, { nextCheckAt: at(-5) });
    const queue = new FakeQueue();
    const scheduler = make(queue, { batchSize: 100, maxBatchesPerTick: 2 });
    expect((await scheduler.tick()).claimed).toBe(200);
    expect((await scheduler.tick()).claimed).toBe(50);
  });

  it("applies backpressure: a full queue means nothing is claimed, and the work waits in the database", async () => {
    await reset();
    const [svc] = await insertServices(ctx, 3, { nextCheckAt: at(-5) });
    const queue = new FakeQueue();
    queue.waiting = 10;
    const scheduler = make(queue, { maxQueueDepth: 10 });

    expect(await scheduler.tick()).toMatchObject({ claimed: 0, backpressure: true });
    const untouched = await ctx.prisma.service.findUniqueOrThrow({
      where: { id: svc?.id as string },
    });
    expect(untouched.nextCheckAt).toEqual(at(-5)); // still due: lag becomes visible, nothing is lost

    queue.waiting = 0;
    expect((await scheduler.tick()).claimed).toBe(3);
  });

  it("gives the claim back when the queue rejects the jobs, so no check is silently skipped", async () => {
    await reset();
    const [svc] = await insertServices(ctx, 1, { nextCheckAt: at(-5) });
    const queue = new FakeQueue();
    const scheduler = make(queue);

    queue.failNext = true;
    await expect(scheduler.tick()).rejects.toThrow("redis is down");
    const after = await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc?.id as string } });
    expect(after.nextCheckAt).toEqual(at(-5));

    expect((await scheduler.tick()).claimed).toBe(1); // picked up on the next tick
    expect(queue.jobs).toHaveLength(1);
  });

  describe("background loop", () => {
    it("picks up services on its own, survives a failing tick, and stops cleanly", async () => {
      await reset();
      const queue = new FakeQueue();
      queue.failNext = true; // first tick fails, the loop must keep going
      const scheduler = new Scheduler({
        prisma: ctx.prisma,
        queue,
        logger: silentLogger(),
        intervalMs: 20,
        batchSize: 100,
        maxQueueDepth: 1000,
      });
      await insertServices(ctx, 1, { nextCheckAt: new Date(Date.now() - 1000) });

      scheduler.start();
      await waitFor(() => queue.jobs.length === 1);

      await scheduler.stop();
      const before = queue.jobs.length;
      await insertServices(ctx, 1, { nextCheckAt: new Date(Date.now() - 1000) });
      await new Promise((r) => setTimeout(r, 200));
      expect(queue.jobs).toHaveLength(before); // nothing happens after stop()
    });
  });
});
