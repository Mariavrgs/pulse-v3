import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_URL,
  bearer,
  createTestContext,
  signup,
  type Account,
  type TestContext,
} from "./test/helpers.js";

describe.skipIf(!DATABASE_URL)("services API", () => {
  let ctx: TestContext;
  let alice: Account;
  let bob: Account;

  beforeAll(async () => {
    ctx = await createTestContext();
    alice = await signup(ctx.app);
    bob = await signup(ctx.app);
  });
  afterAll(() => ctx.close());
  beforeEach(() => ctx.resetResolver());

  const call = (
    who: Account | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    ctx.app.inject({
      method,
      url,
      ...(who ? { headers: bearer(who.accessToken) } : {}),
      ...(payload ? { payload } : {}),
    });

  const create = async (who: Account, body: object = {}) => {
    const res = await call(who, "POST", "/services", {
      name: "API",
      url: "https://example.com/health",
      ...body,
    });
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
    return res.json();
  };

  describe("authentication", () => {
    it.each([
      ["GET", "/services"],
      ["POST", "/services"],
      ["GET", "/services/6f1d1bfa-3a0e-4b9e-9a65-2d6b8f4f5a10"],
      ["PATCH", "/services/6f1d1bfa-3a0e-4b9e-9a65-2d6b8f4f5a10"],
      ["DELETE", "/services/6f1d1bfa-3a0e-4b9e-9a65-2d6b8f4f5a10"],
    ] as const)("%s %s requires a token (401 even with an invalid body)", async (method, url) => {
      const res = await call(null, method, url, { garbage: true });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("create", () => {
    it("registers a service with defaults and never exposes ownerId", async () => {
      const body = await create(alice, { name: "  Checkout API  " });
      expect(body).toMatchObject({
        name: "Checkout API", // trimmed
        url: "https://example.com/health",
        method: "GET",
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        intervalSeconds: 60,
        timeoutMs: 10000,
        degradedLatencyMs: null,
        failureThreshold: 3,
        recoveryThreshold: 2,
        isActive: true,
        status: "UNKNOWN",
        lastCheckedAt: null,
      });
      expect(body).not.toHaveProperty("ownerId");

      const row = await ctx.prisma.service.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.ownerId).toBe(alice.id);
    });

    it("stores the normalized URL and accepts custom configuration", async () => {
      const body = await create(alice, {
        url: "https://Example.com",
        method: "HEAD",
        intervalSeconds: 30,
        timeoutMs: 5000,
        degradedLatencyMs: 800,
        expectedStatusMin: 200,
        expectedStatusMax: 204,
      });
      expect(body.url).toBe("https://example.com/");
      expect(body).toMatchObject({ method: "HEAD", intervalSeconds: 30, degradedLatencyMs: 800 });
    });

    it.each([
      [
        "a server-managed field (ownerId)",
        { ownerId: "00000000-0000-4000-8000-000000000000" },
        "(root)",
      ],
      ["a server-managed field (status)", { status: "UP" }, "(root)"],
      ["a blank name", { name: "   " }, "name"],
      ["interval below 10s", { intervalSeconds: 5 }, "intervalSeconds"],
      ["timeout below 100ms", { timeoutMs: 10 }, "timeoutMs"],
      [
        "timeout not shorter than the interval",
        { intervalSeconds: 10, timeoutMs: 10000 },
        "timeoutMs",
      ],
      [
        "an inverted status range",
        { expectedStatusMin: 300, expectedStatusMax: 200 },
        "expectedStatusMin",
      ],
      ["a zero failure threshold", { failureThreshold: 0 }, "failureThreshold"],
      ["an unsupported method", { method: "POST" }, "method"],
    ])("rejects %s", async (_name, extra, path) => {
      const res = await call(alice, "POST", "/services", {
        name: "X",
        url: "https://example.com",
        ...extra,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(res.json().error.details.some((d: { path: string }) => d.path === path)).toBe(true);
    });

    it("rejects a missing url", async () => {
      const res = await call(alice, "POST", "/services", { name: "No URL" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("SSRF protection at registration", () => {
    it.each([
      ["localhost", "http://localhost/", "BLOCKED_HOSTNAME"],
      ["loopback IP", "http://127.0.0.1/", "BLOCKED_ADDRESS"],
      ["cloud metadata endpoint", "http://169.254.169.254/latest/meta-data/", "BLOCKED_ADDRESS"],
      ["private network", "http://10.0.0.5/admin", "BLOCKED_ADDRESS"],
      ["IPv6 loopback", "http://[::1]/", "BLOCKED_ADDRESS"],
      ["decimal-encoded loopback", "http://2130706433/", "BLOCKED_ADDRESS"],
      ["IPv4-mapped IPv6 loopback", "http://[::ffff:7f00:1]/", "BLOCKED_ADDRESS"],
      ["file scheme", "file:///etc/passwd", "UNSUPPORTED_PROTOCOL"],
      ["embedded credentials", "http://admin:secret@example.com/", "CREDENTIALS_NOT_ALLOWED"],
      ["disallowed port", "http://example.com:5432/", "PORT_NOT_ALLOWED"],
      ["docker-style service name", "http://postgres/", "BLOCKED_HOSTNAME"],
    ])("rejects %s with 422 and stores nothing", async (_name, url, reason) => {
      const before = await ctx.prisma.service.count();
      const res = await call(alice, "POST", "/services", { name: "Evil", url });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({ code: "URL_NOT_ALLOWED", details: { reason } });
      expect(await ctx.prisma.service.count()).toBe(before);
    });

    it("rejects a public-looking hostname that resolves to a private address, without leaking it", async () => {
      ctx.setResolver(async () => [{ address: "10.1.2.3", family: 4 }]);
      const res = await call(alice, "POST", "/services", {
        name: "Rebind",
        url: "https://innocent.example.com/",
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.reason).toBe("BLOCKED_ADDRESS");
      expect(res.body).not.toContain("10.1.2.3");
    });

    it("rejects when only one of several DNS records is private", async () => {
      ctx.setResolver(async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.1", family: 4 },
      ]);
      const res = await call(alice, "POST", "/services", {
        name: "Mixed",
        url: "https://mixed.example.com/",
      });
      expect(res.statusCode).toBe(422);
    });

    it("reports unresolvable hostnames as a policy error, not a 500", async () => {
      ctx.setResolver(async () => {
        throw new Error("ENOTFOUND");
      });
      const res = await call(alice, "POST", "/services", {
        name: "Gone",
        url: "https://nx.example.com/",
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.reason).toBe("DNS_FAILURE");
    });
  });

  describe("list, get and ownership", () => {
    it("shows each user only their own services", async () => {
      const mine = await create(alice, { name: "alice-only" });
      const theirs = await create(bob, { name: "bob-only" });

      const aliceList = (await call(alice, "GET", "/services?limit=100")).json();
      const bobList = (await call(bob, "GET", "/services?limit=100")).json();
      const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);
      expect(ids(aliceList)).toContain(mine.id);
      expect(ids(aliceList)).not.toContain(theirs.id);
      expect(ids(bobList)).toContain(theirs.id);
      expect(ids(bobList)).not.toContain(mine.id);
    });

    it("answers 404, not 403, for another user's service (no existence leak)", async () => {
      const theirs = await create(bob, { name: "private" });
      const other = await call(alice, "GET", `/services/${theirs.id}`);
      const missing = await call(alice, "GET", "/services/6f1d1bfa-3a0e-4b9e-9a65-2d6b8f4f5a10");
      expect(other.statusCode).toBe(404);
      expect(other.json().error.code).toBe(missing.json().error.code);
      expect(other.json().error.message).toBe(missing.json().error.message);
    });

    it("rejects a malformed id with 400", async () => {
      const res = await call(alice, "GET", "/services/not-a-uuid");
      expect(res.statusCode).toBe(400);
    });

    it("paginates with a stable order and an accurate total", async () => {
      const carol = await signup(ctx.app);
      for (let i = 0; i < 5; i++) await create(carol, { name: `svc-${i}` });

      const page1 = (await call(carol, "GET", "/services?limit=2&offset=0")).json();
      const page2 = (await call(carol, "GET", "/services?limit=2&offset=2")).json();
      const page3 = (await call(carol, "GET", "/services?limit=2&offset=4")).json();
      expect(page1).toMatchObject({ total: 5, limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page3.items).toHaveLength(1);

      const all = [...page1.items, ...page2.items, ...page3.items].map((i: { id: string }) => i.id);
      expect(new Set(all).size).toBe(5); // no duplicates, nothing skipped
    });

    it.each([["limit=0"], ["limit=101"], ["limit=abc"], ["offset=-1"]])(
      "rejects %s",
      async (query) => {
        const res = await call(alice, "GET", `/services?${query}`);
        expect(res.statusCode).toBe(400);
      },
    );
  });

  describe("update", () => {
    it("changes only the fields sent", async () => {
      const svc = await create(alice, { name: "before" });
      const res = await call(alice, "PATCH", `/services/${svc.id}`, {
        name: "after",
        degradedLatencyMs: 500,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: "after",
        degradedLatencyMs: 500,
        url: svc.url,
        intervalSeconds: 60,
      });
    });

    it("can clear degradedLatencyMs with null", async () => {
      const svc = await create(alice, { degradedLatencyMs: 300 });
      const res = await call(alice, "PATCH", `/services/${svc.id}`, { degradedLatencyMs: null });
      expect(res.json().degradedLatencyMs).toBeNull();
    });

    it("re-validates a new URL against the SSRF policy and leaves the service untouched on failure", async () => {
      const svc = await create(alice);
      const res = await call(alice, "PATCH", `/services/${svc.id}`, {
        url: "http://169.254.169.254/",
      });
      expect(res.statusCode).toBe(422);
      const row = await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
      expect(row.url).toBe(svc.url);
    });

    it("accepts a valid new URL, normalizes it and schedules an immediate check", async () => {
      const svc = await create(alice);
      await ctx.prisma.service.update({
        where: { id: svc.id },
        data: { nextCheckAt: new Date(Date.now() + 3_600_000) },
      });
      const res = await call(alice, "PATCH", `/services/${svc.id}`, {
        url: "https://Status.Example.org",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().url).toBe("https://status.example.org/");
      const row = await ctx.prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
      expect(row.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("validates cross-field rules against the merged state", async () => {
      const svc = await create(alice); // interval 60s, timeout 10s
      const res = await call(alice, "PATCH", `/services/${svc.id}`, { intervalSeconds: 10 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0].path).toBe("timeoutMs");

      const ok = await call(alice, "PATCH", `/services/${svc.id}`, {
        intervalSeconds: 10,
        timeoutMs: 5000,
      });
      expect(ok.statusCode).toBe(200);
    });

    it.each([
      ["an empty body", {}],
      ["an unknown field", { ownerId: "00000000-0000-4000-8000-000000000000" }],
      ["a server-managed field", { status: "DOWN" }],
    ])("rejects %s", async (_name, payload) => {
      const svc = await create(alice);
      const res = await call(alice, "PATCH", `/services/${svc.id}`, payload);
      expect(res.statusCode).toBe(400);
    });

    it("cannot modify another user's service", async () => {
      const theirs = await create(bob, { name: "bobs" });
      const res = await call(alice, "PATCH", `/services/${theirs.id}`, { name: "hijacked" });
      expect(res.statusCode).toBe(404);
      const row = await ctx.prisma.service.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.name).toBe("bobs");
    });
  });

  describe("delete", () => {
    it("deletes with an empty 204 and the service is gone afterwards", async () => {
      const svc = await create(alice);
      const res = await call(alice, "DELETE", `/services/${svc.id}`);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect((await call(alice, "GET", `/services/${svc.id}`)).statusCode).toBe(404);
      expect((await call(alice, "DELETE", `/services/${svc.id}`)).statusCode).toBe(404);
    });

    it("removes the service's check history and incidents with it", async () => {
      const svc = await create(alice);
      await ctx.prisma.checkResult.create({
        data: { serviceId: svc.id, checkedAt: new Date(), success: true, durationMs: 12 },
      });
      await ctx.prisma.incident.create({
        data: { serviceId: svc.id, type: "DOWNTIME", startedAt: new Date() },
      });
      await call(alice, "DELETE", `/services/${svc.id}`);
      expect(await ctx.prisma.checkResult.count({ where: { serviceId: svc.id } })).toBe(0);
      expect(await ctx.prisma.incident.count({ where: { serviceId: svc.id } })).toBe(0);
    });

    it("cannot delete another user's service", async () => {
      const theirs = await create(bob);
      const res = await call(alice, "DELETE", `/services/${theirs.id}`);
      expect(res.statusCode).toBe(404);
      expect(await ctx.prisma.service.count({ where: { id: theirs.id } })).toBe(1);
    });
  });
});
