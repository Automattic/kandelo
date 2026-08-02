import { describe, expect, it } from "vitest";

import { synchronizeReceivedSharedWasmMemory } from "../src/shared-wasm-memory-growth";

const PAGE_BYTES = 64 * 1024;

describe("received shared WebAssembly.Memory synchronization", () => {
  it("refreshes wasm32 memory without allocating a page", () => {
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 2,
      shared: true,
    });

    synchronizeReceivedSharedWasmMemory(memory, 4);
    expect(memory.buffer.byteLength).toBe(PAGE_BYTES);
  });

  it("refreshes wasm64 memory without allocating a page", () => {
    const memory = new WebAssembly.Memory({
      initial: 1n,
      maximum: 2n,
      shared: true,
      address: "i64",
    } as unknown as WebAssembly.MemoryDescriptor);

    // WHY: the memory64 JavaScript API requires a BigInt page delta, even
    // when the zero delta exists only to refresh this isolate's local view.
    synchronizeReceivedSharedWasmMemory(memory, 8);
    expect(memory.buffer.byteLength).toBe(PAGE_BYTES);
  });
});
