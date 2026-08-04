import { describe, expect, it } from "vitest";

import { compareMedians } from "../../benchmarks/homebrew-query/compare";

describe("Homebrew query benchmark comparison", () => {
  it("flags only latency increases beyond the large-regression threshold", () => {
    expect(compareMedians(
      { warm_info_ms: 100, first_info_ms: 100 },
      { warm_info_ms: 126, first_info_ms: 60 },
      25,
    )).toEqual([
      {
        metric: "first_info_ms",
        before: 100,
        after: 60,
        changePercent: -40,
        regression: false,
      },
      {
        metric: "warm_info_ms",
        before: 100,
        after: 126,
        changePercent: 26,
        regression: true,
      },
    ]);
  });

  it("rejects comparisons with different metric sets", () => {
    expect(() => compareMedians({ one: 1 }, { two: 1 }, 25)).toThrow(
      "different metrics",
    );
  });
});
