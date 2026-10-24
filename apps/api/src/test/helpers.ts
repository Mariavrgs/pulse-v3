import { randomUUID } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@pulse/db/testing";
import { parseConfig, type Config, type Resolver } from "@pulse/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

export const TEST_JWT_SECRET = "a-test-secret-with-at-least-32-characters!!";
export const PUBLIC_IP = "93.184.216.34";
export const DATABASE_URL = process.env.DATABASE_URL;

export interface TestContext {
  app: FastifyInstance;
  db: TestDatabase;
  prisma: TestDatabase["prisma"];
  config: Config;
  /** Moves the clock the app sees (token expiry) without sleeping. */
  advanceTime(ms: number): void;
  /** Replaces what DNS "returns" for hostnames. Reset with resetResolver(). */
  setResolver(resolver: Resolver): void;
  resetResolver(): void;
  close(): Promise<void>;
}

const publicResolver: Resolver = async () => [{ address: PUBLIC_IP, family: 4 }];

export async function createTestContext(
  overrides: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<TestContext> {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
  const db = await createTestDatabase(DATABASE_URL);
  const config = parseConfig({
    DATABASE_URL: db.url,
    REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: TEST_JWT_SECRET,
    NODE_ENV: "test",
  });

  let now = Date.now();
  let resolver: Resolver = publicResolver;
  const app = await buildApp({
    config,
    prisma: db.prisma,
    logger: false,
    clock: () => new Date(now),
    resolver: (hostname) => resolver(hostname),
    ...overrides,
  });

  return {
    app,
    db,
    prisma: db.prisma,
    config,
    advanceTime: (ms) => {
      now += ms;
    },
    setResolver: (r) => {
      resolver = r;
    },
    resetResolver: () => {
      resolver = publicResolver;
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}

export interface Account {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshCookie: string;
}

export const REFRESH_COOKIE = "pulse_refresh";

export async function signup(
  app: FastifyInstance,
  email = `user-${randomUUID()}@example.com`,
  password = "correct horse battery",
): Promise<Account> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value;
  if (!cookie) throw new Error("signup did not set the refresh cookie");
  return {
    id: body.user.id,
    email,
    password,
    accessToken: body.accessToken,
    refreshCookie: cookie,
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
