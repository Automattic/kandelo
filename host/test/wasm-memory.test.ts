import { afterEach, describe, expect, it } from "vitest";
import { WASM_PAGE_SIZE } from "../src/constants";
import { createMemory64, growMemory64 } from "../src/wasm-memory";

const originalMemory = WebAssembly.Memory;

function replaceMemory(value: unknown): void {
  Object.defineProperty(WebAssembly, "Memory", {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  replaceMemory(originalMemory);
});

describe("memory64 compatibility helpers", () => {
  it("retries memory creation with number page counts when BigInt is rejected", () => {
    const descriptors: Array<Record<string, unknown>> = [];
    const FakeMemory = function (_descriptor: WebAssembly.MemoryDescriptor) {
      const descriptor = _descriptor as WebAssembly.MemoryDescriptor & {
        initial: number | bigint;
        maximum: number | bigint;
        address?: string;
      };
      descriptors.push({ ...descriptor });
      if (typeof descriptor.initial === "bigint") {
        throw new TypeError("Conversion from 'BigInt' to 'number' is not allowed.");
      }
      return new originalMemory({
        initial: descriptor.initial,
        maximum: descriptor.maximum as number,
        shared: descriptor.shared,
      });
    };
    replaceMemory(FakeMemory);

    const memory = createMemory64(1, 2, true);

    expect(memory.buffer.byteLength).toBe(WASM_PAGE_SIZE);
    expect(descriptors).toEqual([
      { initial: 1n, maximum: 2n, shared: true, address: "i64" },
      { initial: 1, maximum: 2, shared: true, address: "i64" },
    ]);
  });

  it("retries memory64 grow with a number delta when BigInt is rejected", () => {
    const calls: unknown[] = [];
    const memory = {
      grow(delta: unknown) {
        calls.push(delta);
        if (typeof delta === "bigint") {
          throw new TypeError("Conversion from 'BigInt' to 'number' is not allowed.");
        }
        return 1;
      },
    } as unknown as WebAssembly.Memory;

    growMemory64(memory, 3);

    expect(calls).toEqual([3n, 3]);
  });

  it("does not retry non-TypeError memory64 grow failures", () => {
    const calls: unknown[] = [];
    const memory = {
      grow(delta: unknown) {
        calls.push(delta);
        throw new RangeError("maximum memory size exceeded");
      },
    } as unknown as WebAssembly.Memory;

    expect(() => growMemory64(memory, 3)).toThrow(RangeError);
    expect(calls).toEqual([3n]);
  });
});
