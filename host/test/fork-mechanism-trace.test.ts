import { describe, expect, it } from "vitest";
import { sampleProcessMemoryStats } from "../src/fork-mechanism-trace";
import type { ProcessMemoryAllocator } from "../src/process-memory";

/**
 * The sampler exists to make `traceVforkMechanism` report a DELTA across a
 * fork. What matters is not the numbers but the two behaviours a delta depends
 * on: that tracing off yields `null` rather than zeros, and that each call
 * takes a FRESH reading.
 */
function allocatorReturning(
  readings: number[],
): { allocator: ProcessMemoryAllocator; calls: () => number } {
  let index = 0;
  const allocator = {
    getRetirementStats: () => {
      const liveMemories = readings[Math.min(index, readings.length - 1)];
      index += 1;
      return { liveMemories, liveAliases: liveMemories * 2 };
    },
  } as unknown as ProcessMemoryAllocator;
  return { allocator, calls: () => index };
}

describe("sampleProcessMemoryStats", () => {
  it("returns null when tracing is off, rather than a zeroed record", () => {
    // A zeroed record would make every delta read as a real measurement of no
    // change, and the caller's `if (before && after)` would never skip.
    const { allocator, calls } = allocatorReturning([7]);
    expect(sampleProcessMemoryStats(false, allocator)).toBeNull();
    expect(calls(), "and it does not touch the allocator at all").toBe(0);
  });

  it("takes a fresh reading per call, so a delta can be nonzero", () => {
    // Caching would make before and after identical and every delta zero --
    // the failure that would make the trace silently useless rather than
    // absent.
    const { allocator } = allocatorReturning([3, 5]);
    const before = sampleProcessMemoryStats(true, allocator);
    const after = sampleProcessMemoryStats(true, allocator);
    expect(before?.liveMemories).toBe(3);
    expect(after?.liveMemories).toBe(5);
    expect(after!.liveMemories - before!.liveMemories).toBe(2);
  });

  it("passes the allocator's record through unchanged", () => {
    const { allocator } = allocatorReturning([4]);
    const stats = sampleProcessMemoryStats(true, allocator);
    expect(stats).toMatchObject({ liveMemories: 4, liveAliases: 8 });
  });
});
