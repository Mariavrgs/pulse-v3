import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { createPrismaClient } from "./index.js";
import type { PrismaClient } from "./generated/client.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "../prisma/migrations");

export interface TestDatabase {
  url: string;
  prisma: PrismaClient;
  /** Drops the throwaway database. Never throws: cleanup must not mask test failures. */
  close(): Promise<void>;
}

/**
 * Creates a throwaway database on the server behind `baseUrl`, applies the real migration
 * files in order, and returns a Prisma client connected to it. Integration tests only.
 */
export async function createTestDatabase(baseUrl: string): Promise<TestDatabase> {
  const dbName = `pulse_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;

  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const migrator = new pg.Client({ connectionString: url.toString() });
  await migrator.connect();
  try {
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      await migrator.query(readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }
  } finally {
    await migrator.end();
  }

  const prisma = createPrismaClient(url.toString());
  return {
    url: url.toString(),
    prisma,
    async close() {
      await prisma.$disconnect().catch(() => undefined);
      const cleaner = new pg.Client({ connectionString: baseUrl });
      try {
        await cleaner.connect();
        await cleaner.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch {
        // best effort
      } finally {
        await cleaner.end().catch(() => undefined);
      }
    },
  };
}
