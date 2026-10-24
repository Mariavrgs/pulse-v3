import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_URL, createDbContext, insertServices, type DbContext } from "../test/helpers.js";
import { claimDueServices, releaseClaims } from "./claim.js";

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe.skipIf(!DATABASE_URL)("claimDueServices", () => {
  let ctx: DbContext;
  beforeAll(async () => {
    ctx = await createDbContext();
  });
  afterAll(() => ctx.close());

  const reset = () => ctx.prisma.service.deleteMany();
  const nextCheckAt = async (id: string) =>
    (await ctx.prisma.service.findUniqueOrThrow({ where: { id } })).nextCheckAt;

  it("claims only active services that are due", async () => {
    await reset();
    const [due, inactive, future] = await insertServices(ctx, 3, (i) => ({
      nextCheckAt: [at(-5), at(-5), at(30)][i] as Date,
      isActive: i !== 1,
    }));

    const claimed = await claimDueServices(ctx.prisma, T0, 100);
    expect(claimed.map((c) => c.id)).toEqual([due?.id]);
    expect(await nextCheckAt(inactive?.id as string)).toEqual(at(-5)); // untouched
    expect(await nextCheckAt(future?.id as string)).toEqual(at(30));
  });

  it("keeps the schedule when on time: next = slot + interval, so there is no drift", async () => {
    await reset();
    const [svc] = await insertServices(ctx, 1, { nextCheckAt: at(-2), intervalSeconds: 60 });
    const [claim] = await claimDueServices(ctx.prisma, T0, 10);
    expect(claim?.slot).toEqual(at(-2));
    expect(claim?.claimedUntil).toEqual(at(58));
    expect(await nextCheckAt(svc?.id as string)).toEqual(at(58));
  });

  it("does not burst after downtime: an hour overdue is one check, then back on schedule", async () => {
    await reset();
    await insertServices(ctx, 1, { nextCheckAt: at(-3600), intervalSeconds: 60 });
    const first = await claimDueServices(ctx.prisma, T0, 10);
    expect(first).toHaveLength(1);
    expect(first[0]?.claimedUntil).toEqual(at(60)); // now + interval, not slot + interval

    expect(await claimDueServices(ctx.prisma, T0, 10)).toHaveLength(0); // no catch-up flood
    expect(await claimDueServices(ctx.prisma, at(61), 10)).toHaveLength(1);
  });

  it("serves the most overdue first and respects the limit", async () => {
    await reset();
    await insertServices(ctx, 5, (i) => ({ nextCheckAt: at(-50 + i * 10) }));
    const slots = async () =>
      (await claimDueServices(ctx.prisma, T0, 2)).map((c) => c.slot.getTime());
    expect(await slots()).toEqual([at(-50), at(-40)].map((d) => d.getTime()));
    expect(await slots()).toEqual([at(-30), at(-20)].map((d) => d.getTime()));
    expect(await slots()).toEqual([at(-10).getTime()]);
    expect(await slots()).toEqual([]);
  });

  it("never hands the same service to two concurrent schedulers", async () => {
    await reset();
    await insertServices(ctx, 60, { nextCheckAt: at(-10) });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimDueServices(ctx.prisma, T0, 20)),
    );
    const ids = results.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates, ever

    // Whatever the racers skipped is still claimable: nothing is lost either.
    for (;;) {
      const more = await claimDueServices(ctx.prisma, T0, 20);
      if (more.length === 0) break;
      ids.push(...more.map((c) => c.id));
    }
    expect(new Set(ids).size).toBe(60);
    expect(ids).toHaveLength(60);
  });

  describe("releaseClaims", () => {
    it("restores the original due time so the service is picked up again", async () => {
      await reset();
      const [svc] = await insertServices(ctx, 1, { nextCheckAt: at(-5) });
      const claims = await claimDueServices(ctx.prisma, T0, 10);
      await releaseClaims(ctx.prisma, claims);
      expect(await nextCheckAt(svc?.id as string)).toEqual(at(-5));
      expect(await claimDueServices(ctx.prisma, T0, 10)).toHaveLength(1);
    });

    it("does not overwrite a change made after the claim", async () => {
      await reset();
      const [svc] = await insertServices(ctx, 1, { nextCheckAt: at(-5) });
      const claims = await claimDueServices(ctx.prisma, T0, 10);
      await ctx.prisma.service.update({
        where: { id: svc?.id as string },
        data: { nextCheckAt: at(500) },
      });
      await releaseClaims(ctx.prisma, claims);
      expect(await nextCheckAt(svc?.id as string)).toEqual(at(500));
    });
  });
});
