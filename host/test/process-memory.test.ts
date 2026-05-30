import { describe, expect, it } from "vitest";
import {
  CHANNEL_PAGES,
  DEFAULT_PROCESS_THREAD_SLOTS,
  FORK_SAVE_BUFFER_SIZE,
  PROCESS_MMAP_BASE,
  computeProcessMemoryLayout,
  createProcessMemory,
} from "../src/process-memory";
import { WASM_PAGE_SIZE, DEFAULT_MAX_PAGES, CH_TOTAL_SIZE, PAGES_PER_THREAD } from "../src/constants";

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
    expect(layout.controlBase).toBeGreaterThanOrEqual(heapBase);
    expect(layout.controlEnd).toBeLessThanOrEqual(memory.buffer.byteLength);
    expect(layout.mmapBase).toBe(layout.brkBase);
    expect(layout.mmapBase).toBeLessThan(PROCESS_MMAP_BASE);
    expect(layout.maxAddr).toBe(DEFAULT_MAX_PAGES * WASM_PAGE_SIZE);
  });

  it("places host control before the shared brk/mmap region", () => {
    const heapBase = 0x00120000;
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase,
      minPages: Math.ceil(heapBase / WASM_PAGE_SIZE),
      maxPages: DEFAULT_MAX_PAGES,
    });

    expect(layout.channelPage).toBe(layout.controlBase / WASM_PAGE_SIZE + 1);
    expect(layout.channelOffset - FORK_SAVE_BUFFER_SIZE).toBeGreaterThanOrEqual(layout.controlBase);
    expect(layout.firstThreadBasePage).toBe(layout.channelPage + CHANNEL_PAGES + 2);
    expect(layout.threadSlotCount).toBe(DEFAULT_PROCESS_THREAD_SLOTS);
    expect(layout.threadArenaEndPage).toBe(
      layout.firstThreadBasePage +
        (DEFAULT_PROCESS_THREAD_SLOTS - 1) * PAGES_PER_THREAD +
        CHANNEL_PAGES,
    );
    expect(layout.controlEnd).toBe(layout.threadArenaEndPage * WASM_PAGE_SIZE);
    expect(layout.brkBase).toBe(layout.controlEnd);
    expect(layout.mmapBase).toBe(layout.brkBase);
    expect(layout.brkLimit).toBe(layout.maxAddr);
  });

  it("fails fast when maxPages cannot fit the fixed control slab", () => {
    expect(() => computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 84,
    })).toThrow(/initial pages/);
  });

  it("can shrink the preallocated thread slab with an explicit slot count", () => {
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 256,
      threadSlots: 2,
    });

    expect(layout.initialPages).toBeLessThanOrEqual(256);
    expect(layout.threadSlotCount).toBe(2);
    expect(layout.threadArenaEndPage).toBe(layout.firstThreadBasePage + PAGES_PER_THREAD + CHANNEL_PAGES);
    expect(layout.initialPages).toBe(layout.threadArenaEndPage);
    expect(layout.maxAddr).toBe(256 * WASM_PAGE_SIZE);
  });
});
