import type { Prisma } from "@pulse/db";

/** Accepts the main client or a transaction client, so callers decide the transaction boundary. */
type Db = Prisma.TransactionClient;

export const authRepository = {
  findUserByEmail: (db: Db, email: string) => db.user.findUnique({ where: { email } }),

  findUserById: (db: Db, id: string) => db.user.findUnique({ where: { id } }),

  createUser: (db: Db, email: string, passwordHash: string) =>
    db.user.create({ data: { email, passwordHash } }),

  createRefreshToken: (db: Db, data: { userId: string; tokenHash: string; expiresAt: Date }) =>
    db.refreshToken.create({ data }),

  findRefreshToken: (db: Db, tokenHash: string) =>
    db.refreshToken.findUnique({ where: { tokenHash } }),

  /** Atomic single-use claim: exactly one concurrent caller gets `true`. */
  async claimRefreshToken(db: Db, id: string, now: Date): Promise<boolean> {
    const { count } = await db.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now },
    });
    return count === 1;
  },

  revokeAllForUser: (db: Db, userId: string, now: Date) =>
    db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),

  revokeByHash: (db: Db, tokenHash: string, now: Date) =>
    db.refreshToken.updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: now } }),
};
