import { afterEach, describe, expect, it, vi } from "vitest";
import {
  growMemoryToCover,
  growMemoryToCoverWithFreshBoundary,
} from "../src/process-memory";

const page = 65_536;
const memory32 = (maximum = 8) => new WebAssembly.Memory({
  initial: 1, maximum, shared: true,
});

afterEach(() => vi.restoreAllMocks());

describe("shared process memory growth", () => {
  it("keeps the supported helper's void return value", () => {
    const memory = memory32();
    expect(growMemoryToCover(memory, 2 * page)).toBeUndefined();
    expect(memory.buffer.byteLength).toBe(2 * page);
  });

  it("identifies fresh pages without modifying the existing prefix", () => {
    const memory = memory32();
    new Uint8Array(memory.buffer).fill(0xa5);
    expect(growMemoryToCoverWithFreshBoundary(memory, 3 * page)).toBe(page);
    expect(new Uint8Array(memory.buffer, 0, page).every(value => value === 0xa5)).toBe(true);
    expect(new Uint8Array(memory.buffer, page).every(value => value === 0)).toBe(true);
  });

  it("does not claim existing nonzero storage as fresh", () => {
    const memory = memory32();
    new Uint8Array(memory.buffer).fill(0xa5);
    const grow = vi.spyOn(memory, "grow");
    expect(growMemoryToCoverWithFreshBoundary(memory, page)).toBeUndefined();
    expect(grow).not.toHaveBeenCalled();
    expect(new Uint8Array(memory.buffer).every(value => value === 0xa5)).toBe(true);
  });

  it("uses the actual grow result after a competing grow", () => {
    const memory = memory32();
    const realGrow = memory.grow.bind(memory);
    vi.spyOn(memory, "grow").mockImplementation(delta => {
      realGrow(1);
      new Uint8Array(memory.buffer, page, page).fill(0x7e);
      return realGrow(delta);
    });
    expect(growMemoryToCoverWithFreshBoundary(memory, 3 * page)).toBe(2 * page);
    expect(new Uint8Array(memory.buffer, page, page).every(value => value === 0x7e)).toBe(true);
    expect(new Uint8Array(memory.buffer, 2 * page).every(value => value === 0)).toBe(true);
  });

  it("accepts a satisfied racing growth without claiming its pages as fresh", () => {
    const memory = memory32(3);
    const realGrow = memory.grow.bind(memory);
    vi.spyOn(memory, "grow").mockImplementation(delta => {
      realGrow(2);
      new Uint8Array(memory.buffer, page).fill(0x7e);
      return realGrow(delta); // The stale delta exceeds the maximum.
    });
    expect(growMemoryToCoverWithFreshBoundary(memory, 3 * page)).toBeUndefined();
    expect(memory.buffer.byteLength).toBe(3 * page);
    expect(new Uint8Array(memory.buffer, page).every(value => value === 0x7e)).toBe(true);
  });

  it("preserves an unsatisfied capacity failure", () => {
    const memory = memory32(2);
    expect(() => growMemoryToCoverWithFreshBoundary(memory, 3 * page)).toThrow(RangeError);
    expect(memory.buffer.byteLength).toBe(page);
  });

  it("does not hide another exception when a competing grow covers the range", () => {
    const memory = memory32();
    const realGrow = memory.grow.bind(memory);
    const error = new TypeError("wrong growth argument");
    vi.spyOn(memory, "grow").mockImplementation(() => {
      realGrow(2);
      throw error;
    });
    expect(() => growMemoryToCoverWithFreshBoundary(memory, 3 * page)).toThrow(error);
  });

  it("handles the actual memory64 BigInt growth result", () => {
    const memory = new WebAssembly.Memory({
      initial: 1n, maximum: 8n, shared: true, address: "i64",
    } as unknown as WebAssembly.MemoryDescriptor);
    expect(growMemoryToCoverWithFreshBoundary(memory, 3 * page, 8)).toBe(page);
    expect(memory.buffer.byteLength).toBe(3 * page);
    expect(new Uint8Array(memory.buffer, page).every(value => value === 0)).toBe(true);
  });
});
