import { z } from "zod";

/** "true" | "false" -> boolean. Anything else is rejected (no silent truthiness). */
const boolFromString = z.enum(["true", "false"]).transform((v) => v === "true");

const urlWithProtocol = (protocols: RegExp) => z.url({ protocol: protocols });

/** Value shipped in .env.example. Convenient locally, forbidden in production. */
export const DEV_JWT_SECRET = "dev-only-insecure-secret-do-not-use-in-production";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    DATABASE_URL: urlWithProtocol(/^postgres(ql)?$/),
    REDIS_URL: urlWithProtocol(/^rediss?$/),

    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** HMAC key for access tokens (HS256). Generate with: openssl rand -base64 48 */
    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(20),
    /** Max simultaneous checks against one hostname, per worker process. */
    WORKER_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    /** How often the scheduler looks for due services. */
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    /** The scheduler stops claiming new work while this many jobs are already waiting. */
    MAX_QUEUE_DEPTH: z.coerce.number().int().min(10).max(1000000).default(5000),

    /**
     * SSRF escape hatch. Lets the checker hit loopback/private addresses so that
     * integration tests can use local fake servers. Must never be enabled in production.
     */
    ALLOW_PRIVATE_TARGETS: boolFromString.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "must not be the development placeholder when NODE_ENV=production",
      });
    }
    if (env.NODE_ENV === "production" && env.ALLOW_PRIVATE_TARGETS) {
      ctx.addIssue({
        code: "custom",
        path: ["ALLOW_PRIVATE_TARGETS"],
        message: "must be false when NODE_ENV=production (SSRF protection)",
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Pure: validates a raw environment record and returns typed config.
 * Never reads process.env itself, so it is trivial to test.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

/** Convenience for app entrypoints. */
export function loadConfig(): Config {
  return parseConfig(process.env);
}
