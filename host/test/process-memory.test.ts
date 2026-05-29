import { describe, expect, it } from "vitest";
import {
  CHANNEL_PAGES,
  DEFAULT_BRK_RESERVE_PAGES,
  FORK_SAVE_BUFFER_SIZE,
  PROCESS_MMAP_BASE,
  computeProcessMemoryLayout,
  createProcessMemory,
} from "../src/process-memory";
import { WASM_PAGE_SIZE, DEFAULT_MAX_PAGES, CH_TOTAL_SIZE } from "../src/constants";

describe("process memory layout", () => {
  it("starts shared process memory below the configured maximum", () => {
    const heapBase = 0x00120000;
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase,
      minPages: Math.ceil(heapBase / WASM_PAGE_SIZE),
      maxPages: DEFAULT_MAX_PAGES,
    });

    const memory = createProcessMemory(4, layout);

    expect(memory.buffer.byteLength).toBe(layout.initialPages * WASM_PAGE_SIZE);
    expect(memory.buffer.byteLength).toBeLessThan(DEFAULT_MAX_PAGES * WASM_PAGE_SIZE);
    expect(layout.channelOffset + CH_TOTAL_SIZE).toBeLessThanOrEqual(memory.buffer.byteLength);
    expect(layout.channelOffset).toBeLessThan(PROCESS_MMAP_BASE);
    expect(layout.maxAddr).toBe(DEFAULT_MAX_PAGES * WASM_PAGE_SIZE);
  });

  it("keeps brk below the fork buffer and leaves mmap space above the control arena", () => {
    const heapBase = 0x00120000;
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase,
      minPages: Math.ceil(heapBase / WASM_PAGE_SIZE),
      maxPages: DEFAULT_MAX_PAGES,
    });

    expect(layout.brkLimit).toBe(layout.channelOffset - FORK_SAVE_BUFFER_SIZE);
    expect(layout.brkLimit).toBeGreaterThanOrEqual(
      heapBase + DEFAULT_BRK_RESERVE_PAGES * WASM_PAGE_SIZE,
    );
    expect(layout.firstThreadBasePage).toBe(layout.channelPage + 4);
    expect(layout.threadArenaEndPage).toBe(PROCESS_MMAP_BASE / WASM_PAGE_SIZE);
    expect(layout.threadArenaEndPage - layout.firstThreadBasePage).toBeGreaterThan(CHANNEL_PAGES);
  });

  it("clamps the brk reserve for small maxPages without allocating beyond maxPages", () => {
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 256,
    });

    expect(layout.initialPages).toBeLessThanOrEqual(256);
    expect(layout.initialPages).toBe(256);
    expect(layout.brkLimit).toBeLessThan(PROCESS_MMAP_BASE);
    expect(layout.maxAddr).toBe(256 * WASM_PAGE_SIZE);
  });
});
