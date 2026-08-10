import { describe, expect, it } from "vitest";
import { sampleProcessMemoryStats } from "../src/fork-mechanism-trace";

describe("fork mechanism trace sampling", () => {
  it("does not scan allocator records when tracing is disabled", () => {
    let samples = 0;
    const allocator = {
      getRetirementStats: () => {
        samples++;
        return { liveMemories: 1, liveAliases: 1 };
      },
    };

    expect(sampleProcessMemoryStats(false, allocator)).toBeUndefined();
    expect(samples).toBe(0);
    expect(sampleProcessMemoryStats(true, allocator)).toEqual({
      liveMemories: 1,
      liveAliases: 1,
    });
    expect(samples).toBe(1);
  });
});
