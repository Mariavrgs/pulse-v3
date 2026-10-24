import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATABASE_URL,
  bearer,
  createTestContext,
  signup,
  type TestContext,
} from "./test/helpers.js";

describe.skipIf(!DATABASE_URL)("error handling", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
    // Routes can be added until the first request makes the instance ready.
    ctx.app.get("/__boom", async () => {
      throw new Error("connection string postgres://admin:hunter2@db.internal/prod");
    });
  });
  afterAll(() => ctx.close());

  it("answers unknown routes with the standard error shape", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "NOT_FOUND", message: expect.any(String) });
  });

  it("returns a request id that matches the header, and ignores a client-supplied one", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/nope",
      headers: { "x-request-id": "attacker-chosen" },
    });
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.headers["x-request-id"]).not.toBe("attacker-chosen");
    expect(res.json().error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("turns an unexpected exception into a generic 500 without leaking its message", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/__boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    });
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("db.internal");
  });

  it("answers malformed JSON with a 400 in the standard shape", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("BAD_REQUEST");
  });

  it("rejects oversized bodies with 413", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "a@example.com", password: "x".repeat(70 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("reports every validation problem with its location", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "bad", password: "x" },
    });
    const paths = res
      .json()
      .error.details.map((d: { path: string }) => d.path)
      .sort();
    expect(paths).toEqual(["email", "password"]);
    expect(res.json().error.details[0].in).toBe("body");
  });
});

describe.skipIf(!DATABASE_URL)("OpenAPI documentation", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.close());

  it("serves a valid OpenAPI 3 document covering every route", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/auth/login",
        "/auth/logout",
        "/auth/me",
        "/auth/refresh",
        "/auth/register",
        "/health/live",
        "/health/ready",
        "/services",
        "/services/{id}",
      ].sort(),
    );
  });

  it("documents the bearer scheme, protected operations and error responses", async () => {
    const doc = (await ctx.app.inject({ method: "GET", url: "/docs/json" })).json();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });

    const create = doc.paths["/services"].post;
    expect(create.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(["201", "400", "401", "422"]),
    );
    expect(create.requestBody.content["application/json"].schema.properties).toHaveProperty("url");
    expect(doc.paths["/auth/login"].post.security).toBeUndefined();
  });

  it("serves the interactive UI", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/docs/" });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/html");
  });

  it("does not require authentication to read the docs, but the API it describes does", async () => {
    const account = await signup(ctx.app);
    expect((await ctx.app.inject({ method: "GET", url: "/services" })).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/services",
          headers: bearer(account.accessToken),
        })
      ).statusCode,
    ).toBe(200);
  });
});
