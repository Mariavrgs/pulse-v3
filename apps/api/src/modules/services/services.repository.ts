import type { Prisma, PrismaClient } from "@pulse/db";

/**
 * Every query is scoped by ownerId. There is deliberately no "find by id alone":
 * authorization cannot be forgotten when the data layer will not answer without it.
 */
export class ServicesRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(ownerId: string, limit: number, offset: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where: { ownerId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: limit,
        skip: offset,
      }),
      this.prisma.service.count({ where: { ownerId } }),
    ]);
    return { items, total };
  }

  findOwned(ownerId: string, id: string) {
    return this.prisma.service.findFirst({ where: { id, ownerId } });
  }

  create(data: Prisma.ServiceUncheckedCreateInput) {
    return this.prisma.service.create({ data });
  }

  async updateOwned(ownerId: string, id: string, data: Prisma.ServiceUncheckedUpdateManyInput) {
    const { count } = await this.prisma.service.updateMany({ where: { id, ownerId }, data });
    return count === 1 ? this.findOwned(ownerId, id) : null;
  }

  async deleteOwned(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.service.deleteMany({ where: { id, ownerId } });
    return count === 1;
  }
}
