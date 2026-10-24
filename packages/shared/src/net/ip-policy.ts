import { isIP } from "node:net";

/**
 * Pure IP classification. Everything here fails CLOSED: anything we cannot parse
 * unambiguously is reported as blocked.
 */

interface Range {
  base: bigint;
  prefix: number;
  label: string;
}

const IPV4_DECIMAL = /^(0|[1-9]\d{0,2})$/;

function parseIPv4(input: string): bigint | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_DECIMAL.test(part)) return null; // rejects leading zeros (octal ambiguity)
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIPv6(input: string): bigint | null {
  if (input.includes("%") || isIP(input) !== 6) return null; // scoped addresses are refused

  let s = input;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const headStr = halves[0] ?? "";
  const tailStr = halves[1] ?? "";
  const head = headStr ? headStr.split(":") : [];
  let groups: string[];
  if (halves.length === 2) {
    const rest = tailStr ? tailStr.split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function v4Range(cidr: string, label: string): Range {
  const [addr, prefix] = cidr.split("/") as [string, string];
  return { base: parseIPv4(addr) as bigint, prefix: Number(prefix), label };
}

function v6Range(cidr: string, label: string): Range {
  const [addr, prefix] = cidr.split("/") as [string, string];
  return { base: parseIPv6(addr) as bigint, prefix: Number(prefix), label };
}

const BLOCKED_V4: readonly Range[] = [
  v4Range("0.0.0.0/8", "this-network"),
  v4Range("10.0.0.0/8", "private"),
  v4Range("100.64.0.0/10", "cgnat"),
  v4Range("127.0.0.0/8", "loopback"),
  v4Range("169.254.0.0/16", "link-local"), // includes 169.254.169.254 cloud metadata
  v4Range("172.16.0.0/12", "private"),
  v4Range("192.0.0.0/24", "ietf-protocol"),
  v4Range("192.0.2.0/24", "documentation"),
  v4Range("192.88.99.0/24", "6to4-relay"),
  v4Range("192.168.0.0/16", "private"),
  v4Range("198.18.0.0/15", "benchmarking"),
  v4Range("198.51.100.0/24", "documentation"),
  v4Range("203.0.113.0/24", "documentation"),
  v4Range("224.0.0.0/4", "multicast"),
  v4Range("240.0.0.0/4", "reserved"), // includes 255.255.255.255
];

const BLOCKED_V6: readonly Range[] = [
  v6Range("::/96", "unspecified-loopback-ipv4-compatible"),
  v6Range("100::/64", "discard"),
  v6Range("64:ff9b:1::/48", "nat64-local"),
  v6Range("2001::/23", "ietf-protocol"), // includes Teredo
  v6Range("2001:db8::/32", "documentation"),
  v6Range("3fff::/20", "documentation"),
  v6Range("fc00::/7", "unique-local"),
  v6Range("fe80::/10", "link-local"),
  v6Range("fec0::/10", "site-local"),
  v6Range("ff00::/8", "multicast"),
];

function match(value: bigint, bits: number, ranges: readonly Range[]): string | null {
  for (const r of ranges) {
    const shift = BigInt(bits - r.prefix);
    if (value >> shift === r.base >> shift) return r.label;
  }
  return null;
}

/**
 * Returns a short label for why the address must not be contacted,
 * or null when it is a publicly routable unicast address.
 */
export function blockedReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4 !== null) return match(v4, 32, BLOCKED_V4);

  const v6 = parseIPv6(address);
  if (v6 === null) return "invalid-address";

  // Transition formats embed an IPv4 address: judge the embedded address.
  const embedded = (label: string, ip: bigint): string | null => {
    const reason = match(ip, 32, BLOCKED_V4);
    return reason === null ? null : `${label}:${reason}`;
  };
  if (v6 >> 32n === 0xffffn) return embedded("ipv4-mapped", v6 & 0xffffffffn);
  if (v6 >> 32n === 0x0064ff9bn << 64n) return embedded("nat64", v6 & 0xffffffffn);
  if (v6 >> 112n === 0x2002n) return embedded("6to4", (v6 >> 80n) & 0xffffffffn);

  return match(v6, 128, BLOCKED_V6);
}

export function isBlockedIp(address: string): boolean {
  return blockedReason(address) !== null;
}
