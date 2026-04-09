import { describe, it, expect } from "vitest";
import { ThreadPageAllocator } from "../src/thread-allocator";
import { WASM_PAGE_SIZE, PAGES_PER_THREAD, CH_TOTAL_SIZE } from "../src/constants";

const MAX_PAGES = 256;

function makeMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: MAX_PAGES, maximum: MAX_PAGES, shared: true });
}

describe("ThreadPageAllocator", () => {
  it("allocates from top-down below main channel", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();
    const t = alloc.allocate(mem);

    // Main channel is at top 2 pages, first thread at maxPages - 2 - PAGES_PER_THREAD
    const expectedBase = MAX_PAGES - 2 - PAGES_PER_THREAD;
    expect(t.basePage).toBe(expectedBase);
    expect(t.channelOffset).toBe(expectedBase * WASM_PAGE_SIZE);
    expect(t.tlsAllocAddr).toBe((expectedBase - 2) * WASM_PAGE_SIZE);
  });

  it("allocates consecutive threads downward", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);

    expect(t2.basePage).toBe(t1.basePage - PAGES_PER_THREAD);
    expect(t2.channelOffset).toBe(t2.basePage * WASM_PAGE_SIZE);
  });

  it("reuses freed pages", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);

    alloc.free(t1.basePage);
    const t3 = alloc.allocate(mem);

    // t3 should reuse t1's pages
    expect(t3.basePage).toBe(t1.basePage);
    expect(t3.channelOffset).toBe(t1.channelOffset);
  });

  it("zeros channel and TLS regions on allocate", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();

    // Write non-zero data where the allocation will go
    const expectedBase = MAX_PAGES - 2 - PAGES_PER_THREAD;
    const offset = expectedBase * WASM_PAGE_SIZE;
    new Uint8Array(mem.buffer, offset, 16).fill(0xff);

    const t = alloc.allocate(mem);

    // Channel region should be zeroed
    const channelBytes = new Uint8Array(mem.buffer, t.channelOffset, CH_TOTAL_SIZE);
    expect(channelBytes.every(b => b === 0)).toBe(true);

    // TLS region should be zeroed
    const tlsBytes = new Uint8Array(mem.buffer, t.tlsAllocAddr, WASM_PAGE_SIZE);
    expect(tlsBytes.every(b => b === 0)).toBe(true);
  });

  it("zeros reused pages", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);

    // Write data into allocated region
    new Uint8Array(mem.buffer, t1.channelOffset, 16).fill(0xab);
    new Uint8Array(mem.buffer, t1.tlsAllocAddr, 16).fill(0xcd);

    alloc.free(t1.basePage);
    const t2 = alloc.allocate(mem);

    // Reused allocation should be zeroed
    const channelBytes = new Uint8Array(mem.buffer, t2.channelOffset, CH_TOTAL_SIZE);
    expect(channelBytes.every(b => b === 0)).toBe(true);
    const tlsBytes = new Uint8Array(mem.buffer, t2.tlsAllocAddr, WASM_PAGE_SIZE);
    expect(tlsBytes.every(b => b === 0)).toBe(true);
  });

  it("free list is LIFO", () => {
    const alloc = new ThreadPageAllocator(MAX_PAGES);
    const mem = makeMemory();
    const t1 = alloc.allocate(mem);
    const t2 = alloc.allocate(mem);
    const t3 = alloc.allocate(mem);

    alloc.free(t1.basePage);
    alloc.free(t2.basePage);

    // Should get t2 first (LIFO), then t1
    const r1 = alloc.allocate(mem);
    const r2 = alloc.allocate(mem);
    expect(r1.basePage).toBe(t2.basePage);
    expect(r2.basePage).toBe(t1.basePage);

    // Next allocation should continue top-down from where t3 left off
    const r3 = alloc.allocate(mem);
    expect(r3.basePage).toBe(t3.basePage - PAGES_PER_THREAD);
  });
});
