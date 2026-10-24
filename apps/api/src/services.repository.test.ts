import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServicesRepository } from "./modules/services/services.repository.js";
import { DATABASE_URL, createTestContext, type TestContext } from "./test/helpers.js";

/**
 * Authorization is enforced twice: the service layer checks ownership before writing, and
 * the repository refuses to touch rows the caller does not own. These tests exercise the
 * second layer directly, so removing the first (in a refactor) cannot silently open a hole.
 */
describe.skipIf(!DATABASE_URL)("ServicesRepository ownership scoping", () => {
  let ctx: TestContext;
  let repo: ServicesRepository;
  let owner: string;
  let intruder: string;
  let serviceId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    repo = new ServicesRepository(ctx.prisma);
    const mk = async () =>
      (
        await ctx.prisma.user.create({
          data: { email: `${randomUUID()}@example.com`, passwordHash: "x" },
        })
      ).id;
    owner = await mk();
    intruder = await mk();
    serviceId = (await repo.create({ ownerId: owner, name: "mine", url: "https://example.com/" }))
      .id;
  });
  afterAll(() => ctx.close());

  it("does not return another owner's row", async () => {
    expect(await repo.findOwned(intruder, serviceId)).toBeNull();
    expect(await repo.findOwned(owner, serviceId)).not.toBeNull();
  });

  it("does not update another owner's row, and reports it as not found", async () => {
    expect(await repo.updateOwned(intruder, serviceId, { name: "hijacked" })).toBeNull();
    const row = await ctx.prisma.service.findUniqueOrThrow({ where: { id: serviceId } });
    expect(row.name).toBe("mine");
  });

  it("does not delete another owner's row", async () => {
    expect(await repo.deleteOwned(intruder, serviceId)).toBe(false);
    expect(await ctx.prisma.service.count({ where: { id: serviceId } })).toBe(1);
  });

  it("lists only the caller's rows", async () => {
    const { items, total } = await repo.list(intruder, 10, 0);
    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });
});
