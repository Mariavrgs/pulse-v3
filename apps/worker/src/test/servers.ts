import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "fixtures");
export const SELF_SIGNED_CERT = readFileSync(join(FIXTURES, "self-signed.crt"), "utf8");
const SELF_SIGNED_KEY = readFileSync(join(FIXTURES, "self-signed.key"), "utf8");

export interface TestServer {
  port: number;
  url: string;
  /** Every request the server received, in order. */
  requests: { method: string; url: string; host: string | undefined }[];
  activeConnections(): number;
  /** Highest number of simultaneous connections seen. */
  peakConnections(): number;
  close(): Promise<void>;
}

type Closable = http.Server | https.Server | net.Server;

function track(server: Closable) {
  let active = 0;
  let peak = 0;
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    active++;
    peak = Math.max(peak, active);
    sockets.add(socket);
    socket.on("close", () => {
      active--;
      sockets.delete(socket);
    });
  });
  return {
    active: () => active,
    peak: () => peak,
    destroyAll: () => sockets.forEach((s) => s.destroy()),
  };
}

async function listen(server: Closable): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function closer(server: Closable, stats: ReturnType<typeof track>) {
  return async () => {
    stats.destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

export async function startHttpServer(handler: http.RequestListener): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host });
    handler(req, res);
  });
  const stats = track(server);
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    activeConnections: stats.active,
    peakConnections: stats.peak,
    close: closer(server, stats),
  };
}

export async function startHttpsServer(handler: http.RequestListener): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = https.createServer(
    { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
    (req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host });
      handler(req, res);
    },
  );
  const stats = track(server);
  const port = await listen(server);
  return {
    port,
    url: `https://127.0.0.1:${port}`,
    requests,
    activeConnections: stats.active,
    peakConnections: stats.peak,
    close: closer(server, stats),
  };
}

/** A server that speaks no HTTP: the test decides what to do with each raw socket. */
export async function startRawServer(onSocket: (socket: net.Socket) => void): Promise<TestServer> {
  const server = net.createServer(onSocket);
  const stats = track(server);
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests: [],
    activeConnections: stats.active,
    peakConnections: stats.peak,
    close: closer(server, stats),
  };
}

/** A port that was just free and has nothing listening: connecting is refused. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  { timeoutMs = 5000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface ProbeServer extends TestServer {
  /** Highest number of requests being served at the same moment. */
  peakInflight(): number;
}

/**
 * Answers after `delayMs` and records how many requests were in flight at once. Measured at
 * the request level (not the socket level) so it does not depend on how fast closed sockets
 * are noticed.
 */
export async function startConcurrencyProbe(delayMs: number, status = 200): Promise<ProbeServer> {
  let inflight = 0;
  let peak = 0;
  const base = await startHttpServer((_req, res) => {
    inflight++;
    peak = Math.max(peak, inflight);
    setTimeout(() => {
      inflight--; // before replying, so the next check cannot start while this one still counts
      res.writeHead(status).end("ok");
    }, delayMs);
  });
  return { ...base, peakInflight: () => peak };
}
