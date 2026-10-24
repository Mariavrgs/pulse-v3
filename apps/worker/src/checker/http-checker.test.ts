import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_SIGNED_CERT,
  closedPort,
  startHttpServer,
  startHttpsServer,
  startRawServer,
  waitFor,
  type TestServer,
} from "../test/servers.js";
import { performCheck, type CheckDeps, type CheckTarget } from "./http-checker.js";

const base = {
  method: "GET" as const,
  timeoutMs: 2000,
  expectedStatusMin: 200,
  expectedStatusMax: 299,
};

const check = (url: string, overrides: Partial<CheckTarget> = {}, deps: Partial<CheckDeps> = {}) =>
  performCheck({ url, ...base, ...overrides }, { policy: { allowPrivate: true }, ...deps });

/** Same check with the SSRF policy ON, as in production. */
const guarded = (url: string, resolver?: CheckDeps["policy"]["resolver"]) =>
  performCheck(
    { url, ...base },
    { policy: { allowPrivate: false, ...(resolver ? { resolver } : {}) } },
  );

const servers: TestServer[] = [];
const track = async (p: Promise<TestServer>) => {
  const s = await p;
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("performCheck: how the monitored service behaves", () => {
  it("a healthy service is a success with status and latency", async () => {
    const s = await track(startHttpServer((_req, res) => res.end("ok")));
    const r = await check(`${s.url}/health`);
    expect(r).toMatchObject({
      success: true,
      statusCode: 200,
      errorType: null,
      errorMessage: null,
    });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.requests).toEqual([{ method: "GET", url: "/health", host: `127.0.0.1:${s.port}` }]);
  });

  it("HTTP 500 is a failed check, recorded with its status code (not a thrown error)", async () => {
    const s = await track(startHttpServer((_req, res) => void res.writeHead(500).end("boom")));
    const r = await check(s.url);
    expect(r).toMatchObject({
      success: false,
      statusCode: 500,
      errorType: "UNEXPECTED_STATUS",
      errorMessage: "Unexpected HTTP status 500",
    });
  });

  it("honours a custom expected status range", async () => {
    const s = await track(startHttpServer((_req, res) => void res.writeHead(404).end()));
    expect((await check(s.url)).success).toBe(false);
    expect((await check(s.url, { expectedStatusMin: 404, expectedStatusMax: 404 })).success).toBe(
      true,
    );
  });

  it("sends the configured method", async () => {
    const s = await track(startHttpServer((_req, res) => res.end()));
    await check(s.url, { method: "HEAD" });
    expect(s.requests[0]?.method).toBe("HEAD");
  });

  it("times out when the server accepts the connection but never answers", async () => {
    const s = await track(startHttpServer(() => undefined)); // never responds
    const started = Date.now();
    const r = await check(s.url, { timeoutMs: 300 });
    const took = Date.now() - started;
    expect(r).toMatchObject({
      success: false,
      errorType: "TIMEOUT",
      errorMessage: "Timed out after 300 ms",
    });
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500); // the deadline is enforced, not just reported
  });

  it("times out when headers arrive later than the deadline", async () => {
    const s = await track(
      startHttpServer((_req, res) => void setTimeout(() => res.end("late"), 1000)),
    );
    expect((await check(s.url, { timeoutMs: 300 })).errorType).toBe("TIMEOUT");
  });

  it("reports connection refused", async () => {
    const port = await closedPort();
    const r = await check(`http://127.0.0.1:${port}/`);
    expect(r).toMatchObject({
      success: false,
      errorType: "CONNECTION",
      errorMessage: "Connection refused",
    });
  });

  it("reports a connection that is dropped immediately", async () => {
    const s = await track(startRawServer((socket) => socket.destroy()));
    const r = await check(s.url);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("CONNECTION");
  });

  it("reports a response that is not HTTP at all", async () => {
    const s = await track(startRawServer((socket) => socket.end("this is not http\r\n\r\n")));
    const r = await check(s.url);
    expect(r).toMatchObject({ success: false, errorType: "INVALID_RESPONSE" });
  });

  it("does not read the body: an endless response still counts as fast and the connection is dropped", async () => {
    let closed = false;
    const s = await track(
      startHttpServer((_req, res) => {
        res.writeHead(200);
        const timer = setInterval(() => res.write("x".repeat(1024)), 5);
        res.on("close", () => {
          clearInterval(timer);
          closed = true;
        });
      }),
    );
    const started = Date.now();
    const r = await check(s.url, { timeoutMs: 5000 });
    expect(r.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    await waitFor(() => closed); // we hung up instead of downloading forever
  });
});

describe("performCheck: redirects are never followed", () => {
  it("returns the 3xx as the result and never contacts the Location target", async () => {
    const internal = await track(startHttpServer((_req, res) => res.end("secret")));
    const s = await track(
      startHttpServer(
        (_req, res) => void res.writeHead(302, { location: `${internal.url}/admin` }).end(),
      ),
    );

    const strict = await check(s.url);
    expect(strict).toMatchObject({
      success: false,
      statusCode: 302,
      errorType: "UNEXPECTED_STATUS",
    });

    const lenient = await check(s.url, { expectedStatusMax: 399 }); // user accepts 3xx
    expect(lenient).toMatchObject({ success: true, statusCode: 302 });

    expect(internal.requests).toHaveLength(0);
  });
});

describe("performCheck: SSRF protection (policy ON)", () => {
  it("refuses loopback and metadata addresses without opening a connection", async () => {
    const s = await track(startHttpServer((_req, res) => res.end()));
    const loopback = await guarded(s.url);
    expect(loopback).toMatchObject({
      success: false,
      errorType: "BLOCKED_TARGET",
      durationMs: null,
    });
    expect(s.requests).toHaveLength(0);

    expect((await guarded("http://169.254.169.254/latest/meta-data/")).errorType).toBe(
      "BLOCKED_TARGET",
    );
    expect((await guarded("http://localhost/")).errorType).toBe("BLOCKED_TARGET");
    expect((await guarded("http://[::ffff:7f00:1]/")).errorType).toBe("BLOCKED_TARGET");
  });

  it("refuses a public-looking hostname that now resolves to a private address, and does not leak it", async () => {
    const r = await guarded("http://innocent.example.com/", async () => [
      { address: "10.0.0.5", family: 4 },
    ]);
    expect(r).toMatchObject({ success: false, errorType: "BLOCKED_TARGET" });
    expect(r.errorMessage).not.toContain("10.0.0.5");
  });

  it("classifies DNS problems separately from policy violations", async () => {
    const failing = await guarded("http://nx.example.com/", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(failing).toMatchObject({
      errorType: "DNS",
      errorMessage: "Hostname could not be resolved",
      durationMs: null,
    });
  });
});

describe("performCheck: DNS pinning", () => {
  it("connects to the validated address and never asks DNS again", async () => {
    const s = await track(startHttpServer((_req, res) => res.end("ok")));
    let lookups = 0;
    // "pinned.service.test" does not exist in real DNS. The only way this can succeed is by
    // connecting to the address the policy validated.
    const r = await performCheck(
      { url: `http://pinned.service.test:${s.port}/`, ...base },
      {
        policy: {
          allowPrivate: true,
          resolver: async () => {
            lookups++;
            if (lookups > 1) throw new Error("resolved a second time: rebinding window is open");
            return [{ address: "127.0.0.1", family: 4 }];
          },
        },
      },
    );
    expect(r.success).toBe(true);
    expect(lookups).toBe(1);
    expect(s.requests[0]?.host).toBe(`pinned.service.test:${s.port}`); // virtual host preserved
  });
});

describe("performCheck: TLS", () => {
  it("rejects a certificate it does not trust (verification is on)", async () => {
    const s = await track(startHttpsServer((_req, res) => res.end("ok")));
    const r = await check(s.url);
    expect(r).toMatchObject({ success: false, errorType: "CONNECTION" });
    expect(r.errorMessage).toMatch(/TLS certificate/);
    expect(s.requests).toHaveLength(0); // no HTTP request was ever sent
  });

  it("control: the same server succeeds when its certificate is trusted", async () => {
    const s = await track(startHttpsServer((_req, res) => res.end("ok")));
    const r = await check(s.url, {}, { connectOptions: { ca: SELF_SIGNED_CERT } });
    expect(r).toMatchObject({ success: true, statusCode: 200 });
  });
});
