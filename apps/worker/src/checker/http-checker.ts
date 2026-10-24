import type { CheckErrorType } from "@pulse/db";
import {
  TargetRejectedError,
  validateTarget,
  type TargetPolicyOptions,
  type ValidatedTarget,
} from "@pulse/shared";
import { Agent, request } from "undici";
import { classifyNetworkError } from "./classify-error.js";
import { createPinnedLookup } from "./pinned-lookup.js";

const USER_AGENT = "PulseMonitor/0.3 (uptime check)";
const DNS_TIMEOUT_CAP_MS = 3000;

export interface CheckTarget {
  url: string;
  method: "GET" | "HEAD";
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
}

export interface CheckOutcome {
  success: boolean;
  statusCode: number | null;
  /** Time until response headers arrived (or until the failure). Null when no request was made. */
  durationMs: number | null;
  errorType: CheckErrorType | null;
  errorMessage: string | null;
}

export interface CheckDeps {
  /** SSRF policy: `allowPrivate` and an optional resolver (tests). */
  policy: Pick<TargetPolicyOptions, "allowPrivate" | "resolver">;
  /** Called with errors we could not classify, so the caller can log them. */
  onUnexpectedError?: (err: unknown) => void;
  /** Test seam: extra TLS options (for example a private CA). Never used in production wiring. */
  connectOptions?: { ca?: string | Buffer };
}

const noop = () => undefined;

function failure(
  errorType: CheckErrorType,
  errorMessage: string,
  durationMs: number | null,
  statusCode: number | null = null,
): CheckOutcome {
  return { success: false, statusCode, durationMs, errorType, errorMessage };
}

function policyFailure(err: unknown): CheckOutcome {
  if (!(err instanceof TargetRejectedError)) {
    return failure("INTERNAL", "Unexpected error while validating the target", null);
  }
  if (err.code === "DNS_FAILURE") return failure("DNS", "Hostname could not be resolved", null);
  if (err.code === "DNS_TIMEOUT") return failure("DNS", "DNS lookup timed out", null);
  // err.message is the public text; the internal detail (resolved IPs) stays out of the record.
  return failure("BLOCKED_TARGET", err.message, null);
}

/**
 * One HTTP check. Every outcome of the *monitored service* (up, down, slow, misbehaving)
 * is a returned value, never a thrown error: a failing target is a valid result, not a
 * failed job.
 *
 * Safety properties:
 *  - the URL is re-validated on every run, because DNS changes;
 *  - the connection is pinned to the validated IPs (no second DNS lookup);
 *  - redirects are not followed, so a public URL cannot bounce us to an internal one;
 *  - the response body is never read, so size is irrelevant;
 *  - one deadline covers DNS, connect, TLS and time to headers.
 */
export async function performCheck(target: CheckTarget, deps: CheckDeps): Promise<CheckOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let validated: ValidatedTarget;
  try {
    validated = await validateTarget(target.url, {
      ...deps.policy,
      dnsTimeoutMs: Math.min(DNS_TIMEOUT_CAP_MS, target.timeoutMs),
    });
  } catch (err) {
    return policyFailure(err);
  }

  const remaining = Math.max(1, target.timeoutMs - elapsed());
  const agent = new Agent({
    connect: {
      lookup: createPinnedLookup(validated.addresses),
      timeout: remaining,
      ...deps.connectOptions,
    },
    headersTimeout: remaining,
    bodyTimeout: remaining,
  });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);

  try {
    const res = await request(validated.url, {
      method: target.method,
      dispatcher: agent,
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    });
    const durationMs = elapsed();
    res.body.on("error", noop);
    res.body.destroy(); // not reading the body: a huge or endless response costs nothing

    const status = res.statusCode;
    if (status >= target.expectedStatusMin && status <= target.expectedStatusMax) {
      return { success: true, statusCode: status, durationMs, errorType: null, errorMessage: null };
    }
    return failure("UNEXPECTED_STATUS", `Unexpected HTTP status ${status}`, durationMs, status);
  } catch (err) {
    const classified = classifyNetworkError(err, { timedOut, timeoutMs: target.timeoutMs });
    if (classified.errorType === "INTERNAL") deps.onUnexpectedError?.(err);
    return failure(classified.errorType, classified.message, elapsed());
  } finally {
    clearTimeout(timer);
    agent.destroy().catch(noop);
  }
}
