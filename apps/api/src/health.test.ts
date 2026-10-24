import { createPrismaClient } from "@pulse/db";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DATABASE_URL, TEST_JWT_SECRET, createTestContext } from "./test/helpers.js";
import { parseConfig } from "@pulse/shared";

describe.skipIf(!DATABASE_URL)("health probes", () => {
  it("liveness answers 200 without touching dependencies", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    } finally {
      await ctx.close();
    }
  });

  it("readiness is 200 when the database answers", async () => {
    const ctx = await createTestContext();
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok", checks: { database: { status: "up" } } });
    } finally {
      await ctx.close();
    }
  });

  it("readiness is 503 when a check fails, and does not leak the failure reason", async () => {
    const ctx = await createTestContext({
      healthChecks: [
        {
          name: "queue",
          run: async () => {
            throw new Error("ECONNREFUSED redis://user:hunter2@10.0.0.9:6379");
          },
        },
      ],
    });
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({
        status: "unavailable",
        checks: { database: { status: "up" }, queue: { status: "down" } },
      });
      expect(res.body).not.toContain("hunter2");
      expect(res.body).not.toContain("10.0.0.9");
    } finally {
      await ctx.close();
    }
  });

  it("readiness is 503 when a check hangs past its timeout", async () => {
    const ctx = await createTestContext({
      healthTimeoutMs: 50,
      healthChecks: [{ name: "slow", run: () => new Promise<void>(() => {}) }],
    });
    try {
      const res = await ctx.app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json().checks.slow.status).toBe("down");
    } finally {
      await ctx.close();
    }
  });

  it("with the database unreachable, readiness is 503 but liveness stays 200", async () => {
    const deadPrisma = createPrismaClient("postgresql://pulse:pulse@127.0.0.1:1/pulse");
    const app = await buildApp({
      config: parseConfig({
        DATABASE_URL: "postgresql://pulse:pulse@127.0.0.1:1/pulse",
        REDIS_URL: "redis://localhost:6379",
        JWT_SECRET: TEST_JWT_SECRET,
        NODE_ENV: "test",
      }),
      prisma: deadPrisma,
      logger: false,
      healthTimeoutMs: 1500,
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.database.status).toBe("down");
      const live = await app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
      await deadPrisma.$disconnect().catch(() => undefined);
    }
  });
});
