import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  DATABASE_URL,
  REFRESH_COOKIE,
  TEST_JWT_SECRET,
  bearer,
  createTestContext,
  signup,
  type TestContext,
} from "./test/helpers.js";

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!DATABASE_URL)("auth: registration and login", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  const post = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, payload });

  it("creates an account, returns an access token and sets an httpOnly refresh cookie", async () => {
    const res = await post("/auth/register", {
      email: "new@example.com",
      password: "correct horse battery",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 900,
      user: { email: "new@example.com" },
    });
    expect(typeof body.accessToken).toBe("string");
    expect(body).not.toHaveProperty("refreshToken"); // never in the body

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${REFRESH_COOKIE}=`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/auth/);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toMatch(/Secure/i); // NODE_ENV=test
  });

  it("marks the refresh cookie Secure in production", async () => {
    const prod = await buildApp({
      config: { ...ctx.config, NODE_ENV: "production" },
      prisma: ctx.prisma,
      logger: false,
    });
    try {
      const res = await prod.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "prod@example.com", password: "correct horse battery" },
      });
      expect(String(res.headers["set-cookie"])).toMatch(/Secure/i);
    } finally {
      await prod.close();
    }
  });

  it("stores an argon2id hash and only a hash of the refresh token", async () => {
    const account = await signup(ctx.app);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(account.password);

    const tokens = await ctx.prisma.refreshToken.findMany({ where: { userId: account.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[0]?.tokenHash).not.toBe(account.refreshCookie);
  });

  it("normalizes the email and rejects duplicates regardless of case", async () => {
    await signup(ctx.app, "Mixed.Case@Example.com");
    const stored = await ctx.prisma.user.findUnique({ where: { email: "mixed.case@example.com" } });
    expect(stored).not.toBeNull();

    const dup = await post("/auth/register", {
      email: "MIXED.case@example.COM",
      password: "correct horse battery",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("lets exactly one of several simultaneous sign-ups for the same email win", async () => {
    const email = `race-${randomUUID()}@example.com`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("/auth/register", { email, password: "correct horse battery" }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(4);
  });

  it.each([
    [
      "password shorter than 10 characters",
      { email: "a@example.com", password: "short" },
      "password",
    ],
    [
      "password longer than 128 characters",
      { email: "a@example.com", password: "x".repeat(129) },
      "password",
    ],
    ["invalid email", { email: "not-an-email", password: "correct horse battery" }, "email"],
    [
      "unknown field (privilege escalation attempt)",
      { email: "a@example.com", password: "correct horse battery", role: "admin" },
      "(root)",
    ],
  ])("rejects %s", async (_name, payload, path) => {
    const res = await post("/auth/register", payload);
    expect(res.statusCode).toBe(400);
    const error = res.json().error;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.some((d: { path: string }) => d.path === path)).toBe(true);
  });

  it("logs in with correct credentials (email case-insensitive)", async () => {
    await signup(ctx.app, "login@example.com", "correct horse battery");
    const res = await post("/auth/login", {
      email: "LOGIN@example.com",
      password: "correct horse battery",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("login@example.com");
    expect(res.cookies.some((c) => c.name === REFRESH_COOKIE)).toBe(true);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    await signup(ctx.app, "known@example.com", "correct horse battery");
    const wrongPassword = await post("/auth/login", {
      email: "known@example.com",
      password: "wrong password!!",
    });
    const unknownEmail = await post("/auth/login", {
      email: "ghost@example.com",
      password: "wrong password!!",
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(unknownEmail.json().error).toMatchObject({
      code: wrongPassword.json().error.code,
      message: wrongPassword.json().error.message,
    });
  });
});

describe.skipIf(!DATABASE_URL)("auth: access tokens", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  const me = (headers: Record<string, string>) =>
    ctx.app.inject({ method: "GET", url: "/auth/me", headers });
  const key = new TextEncoder().encode(TEST_JWT_SECRET);
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it("accepts a valid token", async () => {
    const account = await signup(ctx.app);
    const res = await me(bearer(account.accessToken));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: account.id, email: account.email });
  });

  it.each([
    ["no Authorization header", {}],
    ["wrong scheme", { authorization: "Basic dXNlcjpwYXNz" }],
    ["empty bearer", { authorization: "Bearer " }],
    ["garbage token", { authorization: "Bearer not.a.jwt" }],
  ])("rejects %s with 401", async (_name, headers) => {
    const res = await me(headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  // Forged tokens carry the id of a REAL user. Otherwise /auth/me would answer 401 simply
  // because the user does not exist, and these tests would pass without proving anything.
  const forge = (sub: string, opts: { secret?: Uint8Array; iss?: string; aud?: string } = {}) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub)
      .setIssuer(opts.iss ?? "pulse")
      .setAudience(opts.aud ?? "pulse-api")
      .setExpirationTime(nowSeconds() + 600)
      .sign(opts.secret ?? key);

  it("control: a hand-signed token with the right secret and claims IS accepted", async () => {
    const account = await signup(ctx.app);
    const res = await me(bearer(await forge(account.id)));
    expect(res.statusCode).toBe(200); // proves the forgery helper is valid
  });

  it("rejects a token signed with a different secret", async () => {
    const account = await signup(ctx.app);
    const other = new TextEncoder().encode("another-secret-another-secret-another-secret");
    expect((await me(bearer(await forge(account.id, { secret: other })))).statusCode).toBe(401);
  });

  it("rejects an unsigned token (alg: none)", async () => {
    const account = await signup(ctx.app);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: account.id,
      iss: "pulse",
      aud: "pulse-api",
      exp: nowSeconds() + 600,
    })}.`;
    expect((await me(bearer(unsigned))).statusCode).toBe(401);
  });

  it("rejects a correctly signed token meant for a different audience", async () => {
    const account = await signup(ctx.app);
    const token = await forge(account.id, { aud: "other-api" });
    expect((await me(bearer(token))).statusCode).toBe(401);
  });

  it("rejects a correctly signed token from a different issuer", async () => {
    const account = await signup(ctx.app);
    const token = await forge(account.id, { iss: "other" });
    expect((await me(bearer(token))).statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const account = await signup(ctx.app);
    ctx.advanceTime(15 * 60 * 1000 + 5000);
    expect((await me(bearer(account.accessToken))).statusCode).toBe(401);
  });
});

describe.skipIf(!DATABASE_URL)("auth: refresh and logout", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  const refresh = (cookie?: string) =>
    ctx.app.inject({
      method: "POST",
      url: "/auth/refresh",
      ...(cookie ? { cookies: { [REFRESH_COOKIE]: cookie } } : {}),
    });
  const cookieOf = (res: Awaited<ReturnType<typeof refresh>>) =>
    res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value;

  it("rotates: returns a new access token and a different refresh cookie", async () => {
    const account = await signup(ctx.app);
    ctx.advanceTime(20 * 60 * 1000); // the original access token has expired by now

    const res = await refresh(account.refreshCookie);
    expect(res.statusCode).toBe(200);
    const next = cookieOf(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(account.refreshCookie);

    const profile = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: bearer(res.json().accessToken),
    });
    expect(profile.statusCode).toBe(200);
  });

  it("detects reuse of a rotated token and revokes the whole session family", async () => {
    const account = await signup(ctx.app);
    const first = await refresh(account.refreshCookie);
    const rotated = cookieOf(first) as string;

    const replay = await refresh(account.refreshCookie); // attacker (or bug) replays the old one
    expect(replay.statusCode).toBe(401);

    const afterReplay = await refresh(rotated); // the legitimate newer token is now dead too
    expect(afterReplay.statusCode).toBe(401);
  });

  it("lets only one of two simultaneous refreshes with the same token succeed", async () => {
    const account = await signup(ctx.app);
    const results = await Promise.all([
      refresh(account.refreshCookie),
      refresh(account.refreshCookie),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it("rejects a missing, unknown or expired refresh token", async () => {
    expect((await refresh()).statusCode).toBe(401);
    expect((await refresh("never-issued")).statusCode).toBe(401);

    const account = await signup(ctx.app);
    ctx.advanceTime(31 * DAY); // refresh lifetime is 30 days
    expect((await refresh(account.refreshCookie)).statusCode).toBe(401);
  });

  it("logout revokes the token, clears the cookie, and is idempotent", async () => {
    const account = await signup(ctx.app);
    const out = await ctx.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [REFRESH_COOKIE]: account.refreshCookie },
    });
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe("");
    expect(String(out.headers["set-cookie"])).toMatch(new RegExp(`${REFRESH_COOKIE}=;`));

    expect((await refresh(account.refreshCookie)).statusCode).toBe(401);

    const again = await ctx.app.inject({ method: "POST", url: "/auth/logout" });
    expect(again.statusCode).toBe(204);
  });
});
