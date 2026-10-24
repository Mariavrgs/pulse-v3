import { describe, expect, it } from "vitest";
import { ConfigError, DEV_JWT_SECRET, parseConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgresql://pulse:pulse@localhost:5432/pulse",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "a-test-secret-with-at-least-32-characters!!",
};

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const cfg = parseConfig(valid);
    expect(cfg.NODE_ENV).toBe("development");
    expect(cfg.API_PORT).toBe(3000);
    expect(cfg.WORKER_CONCURRENCY).toBe(20);
    expect(cfg.ALLOW_PRIVATE_TARGETS).toBe(false);
  });

  it("coerces numeric and boolean strings", () => {
    const cfg = parseConfig({
      ...valid,
      API_PORT: "8080",
      WORKER_CONCURRENCY: "5",
      ALLOW_PRIVATE_TARGETS: "true",
      NODE_ENV: "test",
    });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.WORKER_CONCURRENCY).toBe(5);
    expect(cfg.ALLOW_PRIVATE_TARGETS).toBe(true);
  });

  it("fails when required variables are missing, listing each problem", () => {
    try {
      parseConfig({});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join("\n");
      expect(problems).toContain("DATABASE_URL");
      expect(problems).toContain("REDIS_URL");
    }
  });

  it("rejects wrong URL protocols", () => {
    expect(() => parseConfig({ ...valid, DATABASE_URL: "http://localhost/db" })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ ...valid, REDIS_URL: "postgres://localhost" })).toThrow(ConfigError);
  });

  it("rejects out-of-range ports and non-boolean flags", () => {
    expect(() => parseConfig({ ...valid, API_PORT: "70000" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, ALLOW_PRIVATE_TARGETS: "yes" })).toThrow(ConfigError);
  });

  it("refuses ALLOW_PRIVATE_TARGETS=true in production", () => {
    expect(() =>
      parseConfig({ ...valid, NODE_ENV: "production", ALLOW_PRIVATE_TARGETS: "true" }),
    ).toThrow(/ALLOW_PRIVATE_TARGETS/);
  });

  it("applies worker and scheduler defaults and bounds", () => {
    const cfg = parseConfig(valid);
    expect(cfg).toMatchObject({
      WORKER_PER_HOST_CONCURRENCY: 5,
      SCHEDULER_INTERVAL_MS: 1000,
      SCHEDULER_BATCH_SIZE: 100,
      MAX_QUEUE_DEPTH: 5000,
    });
    expect(() => parseConfig({ ...valid, WORKER_PER_HOST_CONCURRENCY: "0" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, SCHEDULER_INTERVAL_MS: "10" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, MAX_QUEUE_DEPTH: "1" })).toThrow(ConfigError);
  });

  it("requires a JWT secret of at least 32 characters", () => {
    expect(() => parseConfig({ ...valid, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => parseConfig({ ...valid, JWT_SECRET: "too-short" })).toThrow(/JWT_SECRET/);
  });

  it("applies token lifetime defaults and bounds", () => {
    const cfg = parseConfig(valid);
    expect(cfg.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(cfg.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(() => parseConfig({ ...valid, ACCESS_TOKEN_TTL_SECONDS: "5" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, REFRESH_TOKEN_TTL_DAYS: "365" })).toThrow(ConfigError);
  });

  it("refuses the development JWT placeholder in production only", () => {
    expect(() =>
      parseConfig({ ...valid, NODE_ENV: "production", JWT_SECRET: DEV_JWT_SECRET }),
    ).toThrow(/development placeholder/);
    expect(parseConfig({ ...valid, JWT_SECRET: DEV_JWT_SECRET }).JWT_SECRET).toBe(DEV_JWT_SECRET);
  });

  it("accepts production with the SSRF guard on", () => {
    const cfg = parseConfig({ ...valid, NODE_ENV: "production" });
    expect(cfg.ALLOW_PRIVATE_TARGETS).toBe(false);
  });
});
