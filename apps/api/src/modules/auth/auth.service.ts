import type { Prisma, PrismaClient } from "@pulse/db";
import { AppError, conflict, unauthenticated } from "../../errors.js";
import { authRepository as repo } from "./auth.repository.js";
import { getDummyHash, hashPassword, verifyPassword } from "./passwords.js";
import { generateRefreshToken, hashRefreshToken, type TokenService } from "./tokens.js";

export interface AuthServiceDeps {
  prisma: PrismaClient;
  tokens: TokenService;
  refreshTtlDays: number;
  now?: () => Date;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface SessionWithUser extends Session {
  user: { id: string; email: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export class AuthService {
  private readonly prisma: PrismaClient;
  private readonly tokens: TokenService;
  private readonly refreshTtlDays: number;
  private readonly now: () => Date;

  constructor(deps: AuthServiceDeps) {
    this.prisma = deps.prisma;
    this.tokens = deps.tokens;
    this.refreshTtlDays = deps.refreshTtlDays;
    this.now = deps.now ?? (() => new Date());
  }

  async register(email: string, password: string): Promise<SessionWithUser> {
    const passwordHash = await hashPassword(password);
    try {
      const user = await repo.createUser(this.prisma, normalizeEmail(email), passwordHash);
      const session = await this.issueSession(this.prisma, user.id);
      return { ...session, user: { id: user.id, email: user.email } };
    } catch (err) {
      // The unique index is the source of truth, so two racing sign-ups cannot both succeed.
      if (hasCode(err, "P2002")) {
        throw conflict("EMAIL_TAKEN", "An account with this email already exists");
      }
      throw err;
    }
  }

  async login(email: string, password: string): Promise<SessionWithUser> {
    const user = await repo.findUserByEmail(this.prisma, normalizeEmail(email));
    const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
    if (!user || !valid) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    }
    const session = await this.issueSession(this.prisma, user.id);
    return { ...session, user: { id: user.id, email: user.email } };
  }

  /**
   * Rotation with reuse detection. Each refresh token works once. Presenting one that was
   * already used means it leaked (or the client is broken), so every session of that user
   * is revoked and they must log in again.
   */
  async refresh(rawToken: string): Promise<Session> {
    const now = this.now();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const record = await repo.findRefreshToken(tx, hashRefreshToken(rawToken));
      if (!record || record.expiresAt <= now) return { kind: "invalid" } as const;

      const claimed = await repo.claimRefreshToken(tx, record.id, now);
      if (!claimed) {
        await repo.revokeAllForUser(tx, record.userId, now);
        return { kind: "reuse" } as const;
      }
      return { kind: "ok", session: await this.issueSession(tx, record.userId) } as const;
    });

    if (outcome.kind === "reuse") {
      throw unauthenticated("Refresh token was already used. Please log in again.");
    }
    if (outcome.kind === "invalid") throw unauthenticated("Invalid or expired refresh token");
    return outcome.session;
  }

  /** Idempotent: logging out with an unknown or already revoked token is not an error. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await repo.revokeByHash(this.prisma, hashRefreshToken(rawToken), this.now());
  }

  async getUser(id: string): Promise<{ id: string; email: string }> {
    const user = await repo.findUserById(this.prisma, id);
    if (!user) throw unauthenticated();
    return { id: user.id, email: user.email };
  }

  private async issueSession(db: Prisma.TransactionClient, userId: string): Promise<Session> {
    const access = await this.tokens.signAccess(userId);
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(this.now().getTime() + this.refreshTtlDays * DAY_MS);
    await repo.createRefreshToken(db, {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt,
    });
    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
      refreshExpiresAt,
    };
  }
}
