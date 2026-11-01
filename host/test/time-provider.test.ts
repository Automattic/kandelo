import { describe, expect, it } from "vitest";
import { NodePlatformIO } from "../src/platform/node";
import { BrowserTimeProvider, NodeTimeProvider } from "../src/vfs/time";

function asNanoseconds(value: { sec: number; nsec: number }): bigint {
  return BigInt(value.sec) * 1_000_000_000n + BigInt(value.nsec);
}

describe.each([
  ["NodeTimeProvider", () => new NodeTimeProvider()],
  ["BrowserTimeProvider", () => new BrowserTimeProvider()],
  ["NodePlatformIO", () => new NodePlatformIO()],
] as const)("%s CLOCK_BOOTTIME", (_name, createProvider) => {
  it("uses the same nondecreasing domain as CLOCK_MONOTONIC", () => {
    const provider = createProvider();
    const monotonic = asNanoseconds(provider.clockGettime(1));
    const boottime = asNanoseconds(provider.clockGettime(7));

    expect(boottime).toBeGreaterThanOrEqual(monotonic);
    expect(boottime - monotonic).toBeLessThan(100_000_000n);
  });
});

describe.each([
  ["NodeTimeProvider", () => new NodeTimeProvider()],
  ["BrowserTimeProvider", () => new BrowserTimeProvider()],
] as const)("%s CLOCK_REALTIME", (_name, createProvider) => {
  it("tracks the wall clock at the monotonic clock's resolution", () => {
    const provider = createProvider();
    const before = BigInt(Date.now()) * 1_000_000n;
    const first = asNanoseconds(provider.clockGettime(0));
    // Wait until the monotonic clock has moved by well under a millisecond.
    const start = asNanoseconds(provider.clockGettime(1));
    while (asNanoseconds(provider.clockGettime(1)) - start < 200_000n) { /* spin */ }
    const second = asNanoseconds(provider.clockGettime(0));
    const after = BigInt(Date.now()) * 1_000_000n;

    // A millisecond clock (Date.now()) would return the same reading here.
    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(before - 1_000_000n);
    expect(second).toBeLessThanOrEqual(after + 1_000_000n);
  });
});
