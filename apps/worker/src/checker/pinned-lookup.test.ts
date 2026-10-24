import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { createPinnedLookup } from "./pinned-lookup.js";

const addresses = [
  { address: "93.184.216.34", family: 4 as const },
  { address: "2606:2800:220:1::1", family: 6 as const },
];

function lookup(options: { family?: number; all?: boolean }) {
  return new Promise<{
    err: NodeJS.ErrnoException | null;
    address: string | LookupAddress[];
    family?: number | undefined;
  }>((resolve) => {
    createPinnedLookup(addresses)("ignored.example.com", options, (err, address, family) =>
      resolve({ err, address, family }),
    );
  });
}

describe("createPinnedLookup", () => {
  it("answers only with the validated addresses, whatever hostname is asked", async () => {
    const res = await lookup({ all: true });
    expect(res.address).toEqual(addresses);
  });

  it("returns the first address in single mode", async () => {
    expect(await lookup({})).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("filters by requested IP family", async () => {
    expect((await lookup({ family: 6, all: true })).address).toEqual([addresses[1]]);
    expect((await lookup({ family: 4 })).address).toBe("93.184.216.34");
  });

  it("fails with ENOTFOUND when no validated address matches, instead of falling back to DNS", async () => {
    const only4 = createPinnedLookup([addresses[0] as (typeof addresses)[number]]);
    const res = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      only4("x", { family: 6 }, (err) => resolve(err)),
    );
    expect(res?.code).toBe("ENOTFOUND");
  });
});
