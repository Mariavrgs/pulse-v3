import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { blockedReason } from "./ip-policy.js";

export type RejectionCode =
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "CREDENTIALS_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "BLOCKED_HOSTNAME"
  | "BLOCKED_ADDRESS"
  | "DNS_FAILURE"
  | "DNS_TIMEOUT";

export class TargetRejectedError extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
    /** Internal detail for logs only. Never show to end users (may reveal network layout). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = "TargetRejectedError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TargetPolicyOptions {
  /** Test-only escape hatch: skips hostname, port and address restrictions. */
  allowPrivate?: boolean;
  allowedPorts?: readonly number[];
  resolver?: Resolver;
  dnsTimeoutMs?: number;
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  port: number;
  /**
   * Every address the hostname resolved to, all of which passed validation.
   * The HTTP client MUST connect to one of these exact IPs (DNS pinning); resolving
   * again after validation would reopen the DNS-rebinding window.
   */
  addresses: ResolvedAddress[];
}

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];
const DEFAULT_DNS_TIMEOUT_MS = 3000;
const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export interface TargetSyntax {
  url: URL;
  hostname: string;
  port: number;
  ipLiteral: string | null;
}

/** Synchronous checks that need no network. */
export function validateTargetSyntax(
  raw: string,
  options: Pick<TargetPolicyOptions, "allowPrivate" | "allowedPorts"> = {},
): TargetSyntax {
  const { allowPrivate = false, allowedPorts = DEFAULT_ALLOWED_PORTS } = options;

  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new TargetRejectedError("INVALID_URL", "URL is empty or too long");
  }
  // The WHATWG parser silently strips tabs/newlines; refuse them instead of "fixing" them.
  if (hasControlOrSpace(raw)) {
    throw new TargetRejectedError("INVALID_URL", "URL contains whitespace or control characters");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRejectedError("INVALID_URL", "URL could not be parsed");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetRejectedError("UNSUPPORTED_PROTOCOL", "Only http and https are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TargetRejectedError("CREDENTIALS_NOT_ALLOWED", "Credentials in URLs are not allowed");
  }

  // The parser already normalizes decimal/hex/octal IPv4 forms (e.g. http://2130706433 -> 127.0.0.1).
  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") {
    throw new TargetRejectedError("INVALID_URL", "URL has no host");
  }

  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const ipLiteral = isIP(hostname) !== 0 ? hostname : null;

  if (!allowPrivate) {
    if (!allowedPorts.includes(port)) {
      throw new TargetRejectedError("PORT_NOT_ALLOWED", `Port ${port} is not allowed`);
    }
    if (ipLiteral === null) {
      const blockedName =
        hostname === "localhost" ||
        BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s)) ||
        !hostname.includes("."); // single-label names resolve inside container/cluster networks
      if (blockedName) {
        throw new TargetRejectedError("BLOCKED_HOSTNAME", "This hostname is not allowed");
      }
    }
  }

  return { url, hostname, port, ipLiteral };
}

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TargetRejectedError("DNS_TIMEOUT", "DNS resolution timed out")),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full validation: syntax, then DNS resolution, then EVERY resolved address is checked.
 * A single blocked address rejects the target (an attacker can return a mix of public
 * and private records).
 */
export async function validateTarget(
  raw: string,
  options: TargetPolicyOptions = {},
): Promise<ValidatedTarget> {
  const { allowPrivate = false, resolver = defaultResolver } = options;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

  const { url, hostname, port, ipLiteral } = validateTargetSyntax(raw, options);

  let addresses: ResolvedAddress[];
  if (ipLiteral !== null) {
    addresses = [{ address: ipLiteral, family: isIP(ipLiteral) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await withTimeout(resolver(hostname), dnsTimeoutMs);
    } catch (err) {
      if (err instanceof TargetRejectedError) throw err;
      throw new TargetRejectedError(
        "DNS_FAILURE",
        "Hostname could not be resolved",
        err instanceof Error ? err.message : undefined,
      );
    }
    if (addresses.length === 0) {
      throw new TargetRejectedError("DNS_FAILURE", "Hostname could not be resolved");
    }
  }

  if (!allowPrivate) {
    for (const { address } of addresses) {
      const reason = blockedReason(address);
      if (reason !== null) {
        throw new TargetRejectedError(
          "BLOCKED_ADDRESS",
          "Target resolves to an address that is not allowed",
          `${address} (${reason})`,
        );
      }
    }
  }

  return { url, hostname, port, addresses };
}
