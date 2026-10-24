import { createPrismaClient } from "@pulse/db";
import { ConfigError, loadConfig } from "@pulse/shared";
import { buildApp } from "./app.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const prisma = createPrismaClient(config.DATABASE_URL);
const app = await buildApp({ config, prisma });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close(); // stops accepting connections, waits for in-flight requests
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
