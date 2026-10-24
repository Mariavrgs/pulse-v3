import { describe, expect, it, vi } from "vitest";
import {
  TargetRejectedError,
  validateTarget,
  validateTargetSyntax,
  type Resolver,
  type RejectionCode,
} from "./target-policy.js";

const publicResolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];

async function codeOf(promise: Promise<unknown>): Promise<RejectionCode> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TargetRejectedError) return err.code;
    throw err;
  }
  throw new Error("expected rejection, but the target was accepted");
}

describe("validateTarget: accepted", () => {
  it("accepts a public https URL and returns the pinned addresses", async () => {
    const t = await validateTarget("https://example.com/health?x=1", { resolver: publicResolver });
    expect(t.hostname).toBe("example.com");
    expect(t.port).toBe(443);
    expect(t.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("accepts allowed explicit ports and public IP literals", async () => {
    expect(
      (await validateTarget("http://example.com:8080/", { resolver: publicResolver })).port,
    ).toBe(8080);
    const lit = await validateTarget("http://8.8.8.8/");
    expect(lit.addresses[0]?.address).toBe("8.8.8.8");
  });
});

describe("validateTarget: malicious URLs", () => {
  it.each<[string, string, RejectionCode]>([
    ["file scheme", "file:///etc/passwd", "UNSUPPORTED_PROTOCOL"],
    ["ftp scheme", "ftp://example.com/", "UNSUPPORTED_PROTOCOL"],
    ["gopher scheme", "gopher://example.com:80/_x", "UNSUPPORTED_PROTOCOL"],
    ["javascript scheme", "javascript:alert(1)", "UNSUPPORTED_PROTOCOL"],
    ["credentials", "http://user:pass@example.com/", "CREDENTIALS_NOT_ALLOWED"],
    ["user only", "http://admin@example.com/", "CREDENTIALS_NOT_ALLOWED"],
    ["confusing @ host", "http://example.com@127.0.0.1/", "CREDENTIALS_NOT_ALLOWED"],
    ["not a url", "not a url", "INVALID_URL"],
    ["empty", "", "INVALID_URL"],
    ["newline smuggling", "http://example.com/\r\nHost: evil", "INVALID_URL"],
    ["tab in host", "http://exa\tmple.com/", "INVALID_URL"],
    ["disallowed port (ssh)", "http://example.com:22/", "PORT_NOT_ALLOWED"],
    ["disallowed port (redis)", "http://example.com:6379/", "PORT_NOT_ALLOWED"],
    ["localhost", "http://localhost/", "BLOCKED_HOSTNAME"],
    ["localhost trailing dot", "http://localhost./", "BLOCKED_HOSTNAME"],
    ["subdomain of localhost", "http://anything.localhost/", "BLOCKED_HOSTNAME"],
    [".internal", "http://metadata.google.internal/", "BLOCKED_HOSTNAME"],
    [".local", "http://printer.local/", "BLOCKED_HOSTNAME"],
    ["single label (docker/k8s service)", "http://postgres/", "BLOCKED_HOSTNAME"],
    ["too long", `http://example.com/${"a".repeat(2100)}`, "INVALID_URL"],
  ])("rejects %s", async (_name, url, code) => {
    expect(await codeOf(validateTarget(url, { resolver: publicResolver }))).toBe(code);
  });
});

describe("validateTarget: internal addresses and IP obfuscation", () => {
  it.each<[string, string]>([
    ["loopback", "http://127.0.0.1/"],
    ["loopback high port allowed? still blocked by IP", "http://127.0.0.1:8080/"],
    ["private 10/8", "http://10.0.0.5/"],
    ["private 192.168", "http://192.168.0.1/"],
    ["private 172.16", "http://172.16.5.4/"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["unspecified", "http://0.0.0.0/"],
    ["decimal IPv4", "http://2130706433/"], // 127.0.0.1
    ["hex IPv4", "http://0x7f000001/"],
    ["octal IPv4", "http://0177.0.0.1/"],
    ["short IPv4", "http://127.1/"],
    ["hex dotted IPv4", "http://0x7f.0x0.0x0.0x1/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6 hex", "http://[::ffff:7f00:1]/"],
    ["IPv6 link-local", "http://[fe80::1]/"],
    ["IPv6 ULA", "http://[fd00::1]/"],
    ["NAT64 metadata", "http://[64:ff9b::a9fe:a9fe]/"],
  ])("rejects %s", async (_name, url) => {
    expect(await codeOf(validateTarget(url, { allowedPorts: [80, 443, 8080] }))).toBe(
      "BLOCKED_ADDRESS",
    );
  });
});

describe("validateTarget: DNS-based attacks", () => {
  it("rejects a public-looking name that resolves to a private IP", async () => {
    const resolver: Resolver = async () => [{ address: "10.1.2.3", family: 4 }];
    expect(await codeOf(validateTarget("https://evil.example.com/", { resolver }))).toBe(
      "BLOCKED_ADDRESS",
    );
  });

  it("rejects when ANY record is private (mixed public + private answers)", async () => {
    const resolver: Resolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    expect(await codeOf(validateTarget("https://mixed.example.com/", { resolver }))).toBe(
      "BLOCKED_ADDRESS",
    );
  });

  it("rejects a name resolving to IPv4-mapped loopback or IPv6 ULA", async () => {
    for (const address of ["::ffff:127.0.0.1", "fd00::5"]) {
      const resolver: Resolver = async () => [{ address, family: 6 }];
      expect(await codeOf(validateTarget("https://v6.example.com/", { resolver }))).toBe(
        "BLOCKED_ADDRESS",
      );
    }
  });

  it("re-validates on every call: DNS rebinding flips are caught", async () => {
    const answers = ["93.184.216.34", "169.254.169.254"];
    const resolver: Resolver = async () => [{ address: answers.shift() as string, family: 4 }];
    const first = await validateTarget("https://rebind.example.com/", { resolver });
    expect(first.addresses[0]?.address).toBe("93.184.216.34");
    expect(await codeOf(validateTarget("https://rebind.example.com/", { resolver }))).toBe(
      "BLOCKED_ADDRESS",
    );
  });

  it("maps resolver errors to DNS_FAILURE and empty answers too", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await codeOf(validateTarget("https://nx.example.com/", { resolver: failing }))).toBe(
      "DNS_FAILURE",
    );
    expect(
      await codeOf(validateTarget("https://nx.example.com/", { resolver: async () => [] })),
    ).toBe("DNS_FAILURE");
  });

  it("times out slow DNS", async () => {
    vi.useFakeTimers();
    try {
      const hang: Resolver = () => new Promise(() => {});
      const pending = codeOf(
        validateTarget("https://slow.example.com/", { resolver: hang, dnsTimeoutMs: 50 }),
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toBe("DNS_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the internal detail out of the public message", async () => {
    const resolver: Resolver = async () => [{ address: "10.9.9.9", family: 4 }];
    try {
      await validateTarget("https://leak.example.com/", { resolver });
      expect.unreachable();
    } catch (err) {
      const e = err as TargetRejectedError;
      expect(e.message).not.toContain("10.9.9.9");
      expect(e.detail).toContain("10.9.9.9");
    }
  });
});

describe("allowPrivate escape hatch (tests only)", () => {
  it("permits loopback and arbitrary ports, but still enforces scheme and credentials", async () => {
    const t = await validateTarget("http://127.0.0.1:41234/", { allowPrivate: true });
    expect(t.port).toBe(41234);
    expect(
      (
        await validateTarget("http://localhost:3999/", {
          allowPrivate: true,
          resolver: async () => [{ address: "127.0.0.1", family: 4 }],
        })
      ).addresses,
    ).toHaveLength(1);
    expect(await codeOf(validateTarget("file:///etc/passwd", { allowPrivate: true }))).toBe(
      "UNSUPPORTED_PROTOCOL",
    );
    expect(await codeOf(validateTarget("http://a:b@127.0.0.1/", { allowPrivate: true }))).toBe(
      "CREDENTIALS_NOT_ALLOWED",
    );
  });
});

describe("validateTargetSyntax", () => {
  it("is synchronous and does not resolve DNS", () => {
    const s = validateTargetSyntax("https://example.com");
    expect(s.ipLiteral).toBeNull();
  });
});
