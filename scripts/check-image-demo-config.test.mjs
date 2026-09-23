import { describe, expect, it } from "vitest";
import { checkTrackedDemoConfigs, nearMissKeys } from "./check-image-demo-config.mjs";

describe("tracked demo-config checker", () => {
  it("accepts the repository's tracked sources", () => {
    expect(() => checkTrackedDemoConfigs()).not.toThrow();
  });

  // Review Focus 3: a typo'd block is tolerated as an unknown key, so the
  // machine would boot with defaults and no diagnostic. This is the only
  // place that can catch it.
  it("flags a near-miss key", () => {
    expect(nearMissKeys({ runtimee: {}, init: {} }))
      .toEqual([{ found: "runtimee", meant: "runtime" }]);
  });

  it("allows a genuinely unknown key", () => {
    expect(nearMissKeys({ futureThing: {} })).toEqual([]);
  });

  it("is case-insensitive about near misses", () => {
    expect(nearMissKeys({ Runtime: {} }))
      .toEqual([{ found: "Runtime", meant: "runtime" }]);
  });
});
