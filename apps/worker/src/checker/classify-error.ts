import type { CheckErrorType } from "@pulse/db";

export interface ClassifiedError {
  errorType: CheckErrorType;
  /** Curated text, safe to show in a dashboard. Never a raw exception message. */
  message: string;
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

const CONNECTION_MESSAGES: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset by the server",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  EPIPE: "Connection closed unexpectedly",
  UND_ERR_SOCKET: "Connection closed by the server",
  UND_ERR_CLOSED: "Connection closed",
};

const TLS_MESSAGES: Record<string, string> = {
  CERT_HAS_EXPIRED: "TLS certificate has expired",
  CERT_NOT_YET_VALID: "TLS certificate is not yet valid",
  DEPTH_ZERO_SELF_SIGNED_CERT: "TLS certificate is self-signed",
  SELF_SIGNED_CERT_IN_CHAIN: "TLS certificate chain contains a self-signed certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate cannot be verified",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "TLS certificate issuer is not trusted",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS certificate does not match the hostname",
};

/**
 * Node and undici wrap errors in several layers (cause, AggregateError). Collect every code
 * and name. Names matter because some errors carry none: undici's parser failure is an
 * `HTTPParserError` with no `code` at all.
 */
function collectIdentifiers(
  err: unknown,
  depth = 0,
  out: { codes: string[]; names: string[] } = { codes: [], names: [] },
) {
  if (depth > 3 || typeof err !== "object" || err === null) return out;
  const e = err as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string") out.codes.push(e.code);
  if (typeof e.name === "string") out.names.push(e.name);
  collectIdentifiers(e.cause, depth + 1, out);
  if (Array.isArray(e.errors))
    for (const inner of e.errors) collectIdentifiers(inner, depth + 1, out);
  return out;
}

export function classifyNetworkError(
  err: unknown,
  ctx: { timedOut: boolean; timeoutMs: number },
): ClassifiedError {
  const timeout: ClassifiedError = {
    errorType: "TIMEOUT",
    message: `Timed out after ${ctx.timeoutMs} ms`,
  };
  if (ctx.timedOut) return timeout;

  const { codes, names } = collectIdentifiers(err);
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return timeout;

  for (const code of codes) {
    const tls = TLS_MESSAGES[code];
    if (tls) return { errorType: "CONNECTION", message: tls };
    if (code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS")) {
      return { errorType: "CONNECTION", message: "TLS handshake failed" };
    }
  }
  for (const code of codes) {
    const conn = CONNECTION_MESSAGES[code];
    if (conn) return { errorType: "CONNECTION", message: conn };
  }
  if (codes.some((c) => c.startsWith("HPE_")) || names.includes("HTTPParserError")) {
    return { errorType: "INVALID_RESPONSE", message: "Server sent a malformed HTTP response" };
  }
  return { errorType: "INTERNAL", message: "Unexpected error while checking the service" };
}
