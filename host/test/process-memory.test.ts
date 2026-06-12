import { describe, expect, it } from "vitest";
import {
  CHANNEL_PAGES,
  DEFAULT_PROCESS_THREAD_SLOTS,
  FORK_SAVE_BUFFER_SIZE,
  PROCESS_MMAP_BASE,
  PROCESS_THREAD_SLOTS_USE_HOST_DEFAULT,
  computeProcessMemoryLayout,
  createProcessMemory,
  resolveProcessMaxPages,
} from "../src/process-memory";
import { WASM_PAGE_SIZE, DEFAULT_MAX_PAGES, CH_TOTAL_SIZE, PAGES_PER_THREAD } from "../src/constants";

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return bytes;
}

function sleb128I32(n: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      bytes.push(b);
      return bytes;
    }
    bytes.push(b | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function wasmWithThreadSlotDeclaration(value: number): ArrayBuffer {
  const body = [0x00, 0x41, ...sleb128I32(value), 0x0b];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [
      0x01,
      ...nameBytes("__wasm_posix_thread_slots"), 0x00, 0x00,
    ]),
    ...section(10, [0x01, ...uleb128(body.length), ...body]),
  ]).buffer;
}

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
    expect(layout.firstThreadSlotPage).toBe(layout.channelPage + CHANNEL_PAGES);
    expect(layout.firstThreadBasePage).toBe(layout.firstThreadSlotPage + 2);
    expect(layout.threadSlotCount).toBe(DEFAULT_PROCESS_THREAD_SLOTS);
    expect(layout.threadArenaEndPage).toBe(layout.firstThreadSlotPage);
    expect(layout.controlEnd).toBe(layout.threadArenaEndPage * WASM_PAGE_SIZE);
    expect(layout.brkBase).toBe(layout.controlEnd);
    expect(layout.mmapBase).toBe(layout.brkBase);
    expect(layout.brkLimit).toBe(layout.maxAddr);
  });

  it("fails fast when maxPages cannot fit an explicitly preallocated thread slab", () => {
    expect(() => computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 84,
      preallocateThreadSlots: true,
    })).toThrow(/initial pages/);
  });

  it("can shrink the preallocated thread slab with an explicit slot count", () => {
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 256,
      threadSlots: 2,
      preallocateThreadSlots: true,
    });

    expect(layout.initialPages).toBeLessThanOrEqual(256);
    expect(layout.threadSlotCount).toBe(2);
    expect(layout.threadArenaEndPage).toBe(layout.firstThreadSlotPage + 2 * PAGES_PER_THREAD);
    expect(layout.initialPages).toBe(layout.threadArenaEndPage);
    expect(layout.maxAddr).toBe(256 * WASM_PAGE_SIZE);
  });

  it("can allow no pthread slots for single-threaded declarations", () => {
    const layout = computeProcessMemoryLayout({
      ptrWidth: 4,
      heapBase: 0x00120000,
      minPages: 18,
      maxPages: 256,
      threadSlots: 0,
    });

    expect(layout.threadSlotCount).toBe(0);
    expect(layout.threadArenaEndPage).toBe(layout.firstThreadSlotPage);
    expect(layout.controlEnd).toBe((layout.channelPage + CHANNEL_PAGES) * WASM_PAGE_SIZE);
  });

  it("honors wasm-declared pthread slot limit", () => {
    for (const [decl, expected] of [
      [PROCESS_THREAD_SLOTS_USE_HOST_DEFAULT, 5],
      [0, 0],
      [3, 3],
    ] as const) {
      const layout = computeProcessMemoryLayout({
        ptrWidth: 4,
        heapBase: 0x00120000,
        minPages: 18,
        maxPages: 256,
        programBytes: wasmWithThreadSlotDeclaration(decl),
        defaultThreadSlots: 5,
      });

      expect(layout.threadSlotCount).toBe(expected);
      expect(layout.threadArenaEndPage).toBe(layout.firstThreadSlotPage);
    }
  });
});

describe("process max page policy", () => {
  it("keeps the high cap only for configured executable basenames", () => {
    const highMemoryNames = new Set(["mariadbd"]);

    expect(resolveProcessMaxPages({
      configuredMaxPages: 16384,
      ordinaryProcessMaxPages: 4096,
      highMemoryProcessBasenames: highMemoryNames,
      argv: ["/usr/sbin/mariadbd", "--no-defaults"],
    })).toBe(16384);

    expect(resolveProcessMaxPages({
      configuredMaxPages: 16384,
      ordinaryProcessMaxPages: 4096,
      highMemoryProcessBasenames: highMemoryNames,
      argv: ["/bin/sh", "/etc/mariadb/bootstrap.sh"],
    })).toBe(4096);
  });

  it("leaves configured caps alone when the ordinary cap is not lower", () => {
    expect(resolveProcessMaxPages({
      configuredMaxPages: 2048,
      ordinaryProcessMaxPages: 4096,
      highMemoryProcessBasenames: ["mariadbd"],
      argv: ["/bin/sh"],
    })).toBe(2048);

    expect(resolveProcessMaxPages({
      configuredMaxPages: 16384,
      argv: ["/bin/sh"],
    })).toBe(16384);
  });
});
