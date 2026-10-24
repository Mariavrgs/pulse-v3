import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Applies the real migration files to a throwaway database and checks the guarantees the
 * application relies on. Needs only Postgres (DATABASE_URL), not the Prisma engines.
 * Skipped automatically when DATABASE_URL is not set.
 */
const adminUrl = process.env.DATABASE_URL;
const MIGRATIONS_DIR = join(import.meta.dirname, "../prisma/migrations");

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe.skipIf(!adminUrl)("database migrations (integration)", () => {
  const dbName = `pulse_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin: pg.Client;
  let db: pg.Client;

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO "User"(id, email, "passwordHash") VALUES ($1, $2, 'x')`, [
      id,
      `${id}@example.com`,
    ]);
    return id;
  }

  async function newService(ownerId: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    const cols: Record<string, unknown> = {
      id,
      ownerId,
      name: "svc",
      url: "https://example.com",
      updatedAt: new Date(),
      ...overrides,
    };
    const keys = Object.keys(cols);
    await db.query(
      `INSERT INTO "Service"(${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      Object.values(cols),
    );
    return id;
  }

  const openIncident = (serviceId: string, type = "DOWNTIME") =>
    db.query(
      `INSERT INTO "Incident"(id, "serviceId", type, "startedAt") VALUES ($1, $2, $3, now())`,
      [randomUUID(), serviceId, type],
    );

  async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    db = new pg.Client({ connectionString: urlForDatabase(adminUrl as string, dbName) });
    await db.connect();

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      await db.query(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }
  });

  afterAll(async () => {
    // Best effort: if the database was unreachable, the connection error from beforeAll is the
    // useful one. A failing cleanup must not bury it.
    await db?.end().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE "User" CASCADE`);
  });

  describe("incident deduplication", () => {
    it("rejects a second open incident for the same service", async () => {
      const svc = await newService(await newUser());
      await openIncident(svc);
      expect(await sqlState(openIncident(svc))).toBe("23505"); // unique_violation
    });

    it("also blocks an open DEGRADATION while a DOWNTIME is open (one open incident total)", async () => {
      const svc = await newService(await newUser());
      await openIncident(svc, "DOWNTIME");
      expect(await sqlState(openIncident(svc, "DEGRADATION"))).toBe("23505");
    });

    it("allows a new incident once the previous one is resolved, and keeps history", async () => {
      const svc = await newService(await newUser());
      await openIncident(svc);
      await db.query(`UPDATE "Incident" SET "resolvedAt" = now() WHERE "serviceId" = $1`, [svc]);
      await openIncident(svc);
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM "Incident" WHERE "serviceId" = $1`,
        [svc],
      );
      expect(rows[0].n).toBe(2);
    });

    it("allows open incidents on different services at the same time", async () => {
      const owner = await newUser();
      await openIncident(await newService(owner));
      await openIncident(await newService(owner));
    });

    it("holds under concurrent attempts: exactly one wins", async () => {
      const svc = await newService(await newUser());
      const url = urlForDatabase(adminUrl as string, dbName);
      const clients = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const c = new pg.Client({ connectionString: url });
          await c.connect();
          return c;
        }),
      );
      try {
        const results = await Promise.allSettled(
          clients.map((c) =>
            c.query(
              `INSERT INTO "Incident"(id, "serviceId", type, "startedAt") VALUES ($1, $2, 'DOWNTIME', now())`,
              [randomUUID(), svc],
            ),
          ),
        );
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it("rejects an incident that resolves before it started", async () => {
      const svc = await newService(await newUser());
      const q = db.query(
        `INSERT INTO "Incident"(id, "serviceId", type, "startedAt", "resolvedAt") VALUES ($1, $2, 'DOWNTIME', now(), now() - interval '1 minute')`,
        [randomUUID(), svc],
      );
      expect(await sqlState(q)).toBe("23514"); // check_violation
    });
  });

  describe("service configuration constraints", () => {
    it("applies sane defaults", async () => {
      const id = await newService(await newUser());
      const { rows } = await db.query(`SELECT * FROM "Service" WHERE id = $1`, [id]);
      expect(rows[0]).toMatchObject({
        method: "GET",
        intervalSeconds: 60,
        timeoutMs: 10000,
        failureThreshold: 3,
        recoveryThreshold: 2,
        status: "UNKNOWN",
        isActive: true,
        consecutiveFailures: 0,
      });
    });

    it.each([
      ["interval below 10s", { intervalSeconds: 5, timeoutMs: 1000 }],
      ["interval above 24h", { intervalSeconds: 86401 }],
      ["timeout below 100ms", { timeoutMs: 50 }],
      ["timeout not smaller than interval", { intervalSeconds: 10, timeoutMs: 10000 }],
      ["inverted expected status range", { expectedStatusMin: 300, expectedStatusMax: 200 }],
      ["expected status out of range", { expectedStatusMax: 700 }],
      ["zero failure threshold", { failureThreshold: 0 }],
      ["non-positive degraded latency", { degradedLatencyMs: 0 }],
    ])("rejects %s", async (_name, overrides) => {
      const owner = await newUser();
      expect(await sqlState(newService(owner, overrides))).toBe("23514");
    });

    it("rejects invalid enum values", async () => {
      const owner = await newUser();
      expect(await sqlState(newService(owner, { method: "POST" }))).toBe("22P02");
    });
  });

  describe("check result invariants", () => {
    const insertCheck = (
      serviceId: string,
      success: boolean,
      errorType: string | null,
      duration: number | null = 10,
    ) =>
      db.query(
        `INSERT INTO "CheckResult"("serviceId", "checkedAt", success, "durationMs", "errorType") VALUES ($1, now(), $2, $3, $4)`,
        [serviceId, success, duration, errorType],
      );

    it("accepts a success without error and a failure with an error type", async () => {
      const svc = await newService(await newUser());
      await insertCheck(svc, true, null);
      await insertCheck(svc, false, "TIMEOUT");
      await insertCheck(svc, false, "UNEXPECTED_STATUS");
    });

    it("rejects a success that carries an error type", async () => {
      const svc = await newService(await newUser());
      expect(await sqlState(insertCheck(svc, true, "TIMEOUT"))).toBe("23514");
    });

    it("rejects a failure without an error type", async () => {
      const svc = await newService(await newUser());
      expect(await sqlState(insertCheck(svc, false, null))).toBe("23514");
    });

    it("rejects a negative duration", async () => {
      const svc = await newService(await newUser());
      expect(await sqlState(insertCheck(svc, true, null, -1))).toBe("23514");
    });
  });

  describe("relations", () => {
    it("rejects a service for a non-existent owner", async () => {
      expect(await sqlState(newService(randomUUID()))).toBe("23503"); // foreign_key_violation
    });

    it("rejects duplicate emails", async () => {
      const insert = () =>
        db.query(
          `INSERT INTO "User"(id, email, "passwordHash") VALUES ($1, 'a@example.com', 'x')`,
          [randomUUID()],
        );
      await insert();
      expect(await sqlState(insert())).toBe("23505");
    });

    it("keeps refresh token hashes unique and cascades them when the user is deleted", async () => {
      const owner = await newUser();
      const insert = (hash: string) =>
        db.query(
          `INSERT INTO "RefreshToken"(id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`,
          [randomUUID(), owner, hash],
        );
      await insert("hash-a");
      expect(await sqlState(insert("hash-a"))).toBe("23505");

      await db.query(`DELETE FROM "User" WHERE id = $1`, [owner]);
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM "RefreshToken"`);
      expect(rows[0].n).toBe(0);
    });

    it("cascades deletes from user to services, checks and incidents", async () => {
      const owner = await newUser();
      const svc = await newService(owner);
      await db.query(
        `INSERT INTO "CheckResult"("serviceId", "checkedAt", success) VALUES ($1, now(), true)`,
        [svc],
      );
      await openIncident(svc);

      await db.query(`DELETE FROM "User" WHERE id = $1`, [owner]);

      for (const table of ["Service", "CheckResult", "Incident"]) {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${table}"`);
        expect(rows[0].n, table).toBe(0);
      }
    });
  });

  describe("indexes", () => {
    it("has the indexes the scheduler and history queries rely on", async () => {
      const { rows } = await db.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
      );
      const defs = new Map(rows.map((r) => [r.indexname, r.indexdef]));
      expect(defs.get("Service_isActive_nextCheckAt_idx")).toBeDefined();
      expect(defs.get("CheckResult_serviceId_checkedAt_idx")).toMatch(/"checkedAt" DESC/);
      expect(defs.get("Incident_one_open_per_service")).toMatch(
        /UNIQUE.*WHERE \("resolvedAt" IS NULL\)/,
      );
    });
  });
});
