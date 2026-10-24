import { describe, expect, it } from "vitest";
import { classifyNetworkError } from "./classify-error.js";

const ctx = { timedOut: false, timeoutMs: 5000 };
const withCode = (code: string, extra: object = {}) =>
  Object.assign(new Error("boom"), { code, ...extra });

describe("classifyNetworkError", () => {
  it.each([
    ["ECONNREFUSED", "CONNECTION", "Connection refused"],
    ["ECONNRESET", "CONNECTION", "Connection reset by the server"],
    ["EHOSTUNREACH", "CONNECTION", "Host unreachable"],
    ["UND_ERR_SOCKET", "CONNECTION", "Connection closed by the server"],
    ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT", "Timed out after 5000 ms"],
    ["UND_ERR_HEADERS_TIMEOUT", "TIMEOUT", "Timed out after 5000 ms"],
    ["ETIMEDOUT", "TIMEOUT", "Timed out after 5000 ms"],
    ["HPE_INVALID_CONSTANT", "INVALID_RESPONSE", "Server sent a malformed HTTP response"],
    ["CERT_HAS_EXPIRED", "CONNECTION", "TLS certificate has expired"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "CONNECTION", "TLS certificate is self-signed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "CONNECTION", "TLS certificate does not match the hostname"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "CONNECTION", "TLS handshake failed"],
  ])("%s -> %s", (code, type, message) => {
    expect(classifyNetworkError(withCode(code), ctx)).toEqual({ errorType: type, message });
  });

  it("recognizes undici's parser error, which has a name but no code", () => {
    const parserError = Object.assign(new Error("Response does not match the HTTP/1.1 protocol"), {
      name: "HTTPParserError",
    });
    expect(classifyNetworkError(parserError, ctx)).toEqual({
      errorType: "INVALID_RESPONSE",
      message: "Server sent a malformed HTTP response",
    });
  });

  it("finds the code inside a cause chain and inside an AggregateError", () => {
    expect(
      classifyNetworkError(new Error("x", { cause: withCode("ECONNREFUSED") }), ctx).errorType,
    ).toBe("CONNECTION");
    const aggregate = new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")]);
    expect(classifyNetworkError(aggregate, ctx).message).toBe("Connection refused");
  });

  it("lets our own deadline win over whatever error the abort produced", () => {
    const result = classifyNetworkError(withCode("ECONNRESET"), { timedOut: true, timeoutMs: 300 });
    expect(result).toEqual({ errorType: "TIMEOUT", message: "Timed out after 300 ms" });
  });

  it("never echoes raw error text: unknown failures become a generic INTERNAL message", () => {
    const result = classifyNetworkError(new Error("secret at 10.0.0.9:5432"), ctx);
    expect(result.errorType).toBe("INTERNAL");
    expect(result.message).not.toContain("10.0.0.9");
    expect(classifyNetworkError("a string", ctx).errorType).toBe("INTERNAL");
    expect(classifyNetworkError(null, ctx).errorType).toBe("INTERNAL");
  });
});
