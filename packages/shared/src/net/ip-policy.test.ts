import { describe, expect, it } from "vitest";
import { blockedReason, isBlockedIp } from "./ip-policy.js";

describe("isBlockedIp: IPv4", () => {
  it.each([
    ["0.0.0.0"],
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["100.64.0.1"],
    ["127.0.0.1"],
    ["127.255.255.254"],
    ["169.254.169.254"], // cloud metadata
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.168.1.1"],
    ["198.18.0.1"],
    ["224.0.0.1"],
    ["255.255.255.255"],
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["172.15.255.255"], ["172.32.0.1"], ["100.63.255.255"]])(
    "allows public %s (range edges)",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("fails closed on malformed input", () => {
    for (const bad of ["", "999.1.1.1", "1.2.3", "01.2.3.4", "127.1", "abc", "1.2.3.4.5"]) {
      expect(blockedReason(bad), bad).toBe("invalid-address");
    }
  });
});

describe("isBlockedIp: IPv6", () => {
  it.each([
    ["::"],
    ["::1"],
    ["fe80::1"],
    ["fc00::1"],
    ["fd12:3456:789a::1"],
    ["ff02::1"],
    ["2001:db8::1"],
    ["2001::1"], // Teredo
    ["fec0::1"],
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["::ffff:127.0.0.1"],
    ["::ffff:7f00:1"], // hex form of the same address
    ["::ffff:10.0.0.1"],
    ["::ffff:169.254.169.254"],
    ["::ffff:a9fe:a9fe"],
    ["64:ff9b::7f00:1"], // NAT64 wrapping loopback
    ["64:ff9b::a9fe:a9fe"], // NAT64 wrapping metadata IP
    ["2002:7f00:0001::"], // 6to4 wrapping loopback
    ["2002:c0a8:0101::1"], // 6to4 wrapping 192.168.1.1
    ["0:0:0:0:0:0:0:1"], // uncompressed loopback
    ["::0001"],
  ])("blocks IPv4 smuggled inside IPv6: %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["2606:4700:4700::1111"],
    ["2001:4860:4860::8888"],
    ["::ffff:8.8.8.8"],
    ["64:ff9b::808:808"],
  ])("allows public %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("refuses scoped and malformed IPv6", () => {
    expect(isBlockedIp("fe80::1%eth0")).toBe(true);
    expect(isBlockedIp("1::2::3")).toBe(true);
    expect(isBlockedIp("12345::1")).toBe(true);
    expect(isBlockedIp("::ffff:1.2.3")).toBe(true);
  });
});
