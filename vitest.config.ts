import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Load the repo-root .env so integration tests can find DATABASE_URL. Real env vars win.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    // Integration tests share one Postgres; each file creates its own throwaway database.
    fileParallelism: true,
  },
});
