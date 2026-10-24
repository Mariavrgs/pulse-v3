import type { LookupFunction } from "node:net";
import type { ResolvedAddress } from "@pulse/shared";

/**
 * A DNS `lookup` that never touches DNS: it answers with the addresses the SSRF policy
 * already validated. Handing this to the HTTP client's connector means the socket can only
 * be opened to an IP we approved, so a hostname that re-resolves differently a moment later
 * (DNS rebinding) cannot redirect the connection. TLS still verifies the certificate against
 * the original hostname, because only the address is pinned, not the name.
 */
export function createPinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = options.family === 4 || options.family === 6 ? options.family : undefined;
    const candidates = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    const first = candidates[0];
    if (!first) {
      const err: NodeJS.ErrnoException = new Error("no validated address for this IP family");
      err.code = "ENOTFOUND";
      callback(err, "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        candidates.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      callback(null, first.address, first.family);
    }
  };
}
