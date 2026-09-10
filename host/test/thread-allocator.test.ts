import { describe, it, expect } from "vitest";
import {
  materializeThreadSlot,
  threadSlotOffsets,
  THREAD_SLOT_BYTES,
} from "../src/thread-allocator";
import { WASM_PAGE_SIZE, PAGES_PER_THREAD, CH_TOTAL_SIZE } from "../src/constants";

const MAX_PAGES = 256;
const SLOT_PAGE = 24;
const SLOT_ADDR = SLOT_PAGE * WASM_PAGE_SIZE;

function makeMemory(initial = SLOT_PAGE): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial, maximum: MAX_PAGES, shared: true });
}

describe("pthread control slot materialization", () => {
  it("derives the slot's page offsets from the ABI constants", () => {
    const slot = threadSlotOffsets(SLOT_ADDR);

    expect(slot.slotStartPage).toBe(SLOT_PAGE);
    expect(slot.tlsOffset).toBe(SLOT_PAGE * WASM_PAGE_SIZE);
    expect(slot.forkSaveOffset).toBe((SLOT_PAGE + 1) * WASM_PAGE_SIZE);
    expect(slot.channelOffset).toBe((SLOT_PAGE + 2) * WASM_PAGE_SIZE);
    expect(THREAD_SLOT_BYTES).toBe(PAGES_PER_THREAD * WASM_PAGE_SIZE);
  });

  it("refuses an address that is not a whole page", () => {
    // Placement is the kernel's decision, so a misaligned address means this
    // host is reading something other than what the kernel placed. Say so
    // rather than silently building offsets into the middle of a page.
    expect(() => threadSlotOffsets(SLOT_ADDR + 1)).toThrow(/invalid pthread control slot/);
    expect(() => threadSlotOffsets(0)).toThrow(/invalid pthread control slot/);
  });

  it("grows memory only far enough to cover the placed slot", () => {
    const mem = makeMemory(8);

    const slot = materializeThreadSlot(mem, SLOT_ADDR);

    expect(mem.buffer.byteLength).toBe(SLOT_ADDR + THREAD_SLOT_BYTES);
    expect(mem.buffer.byteLength).toBeLessThan(MAX_PAGES * WASM_PAGE_SIZE);
    expect(slot.slotStartPage).toBe(SLOT_PAGE);
  });

  it("zeros the channel, TLS and fork-save pages", () => {
    const mem = makeMemory(SLOT_PAGE + PAGES_PER_THREAD);

    // Dirty the range first: a slot the kernel hands back after an earlier
    // thread released it carries that thread's bytes, and a thread must never
    // start on them.
    new Uint8Array(mem.buffer, SLOT_ADDR, THREAD_SLOT_BYTES).fill(0xab);

    const slot = materializeThreadSlot(mem, SLOT_ADDR);

    const channelBytes = new Uint8Array(mem.buffer, slot.channelOffset, CH_TOTAL_SIZE);
    expect(channelBytes.every((b) => b === 0)).toBe(true);
    const tlsBytes = new Uint8Array(mem.buffer, slot.tlsOffset, WASM_PAGE_SIZE);
    expect(tlsBytes.every((b) => b === 0)).toBe(true);
    const forkSaveBytes = new Uint8Array(mem.buffer, slot.forkSaveOffset, WASM_PAGE_SIZE);
    expect(forkSaveBytes.every((b) => b === 0)).toBe(true);
  });
});
