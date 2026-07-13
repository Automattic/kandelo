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
