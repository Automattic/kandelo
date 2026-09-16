import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";
import { FORK_SAVE_BUFFER_SIZE, growMemoryToCover } from "./process-memory";
import {
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
} from "./generated/abi";

/** Bytes one pthread control slot occupies in a process address space. */
export const THREAD_SLOT_BYTES = PAGES_PER_THREAD * WASM_PAGE_SIZE;

export interface ThreadAllocation {
  /** Start page of the pthread slot. */
  slotStartPage: number;
  /** @deprecated Use slotStartPage. */
  basePage: number;
  /** Byte offset of the TLS/control page in Memory. */
  tlsOffset: number;
  /** Byte offset of the per-thread fork-save/scratch page in Memory. */
  forkSaveOffset: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** @deprecated Use tlsOffset. */
  tlsAllocAddr: number;
}

/**
 * The byte offsets inside a pthread control slot placed at `slotStartAddr`.
 *
 * Slot layout, relative to the slot start:
 *   slotStart+0 - TLS/control page
 *   slotStart+1 - fork-save/scratch page
 *   slotStart+2 - syscall channel primary page
 *   slotStart+3 - syscall channel spill page
 *
 * These are ABI constants, read from the generated bindings rather than
 * restated, so this host and the native host derive the same offsets from the
 * one definition in `wasm-posix-shared`.
 */
export function threadSlotOffsets(slotStartAddr: number): ThreadAllocation {
  if (
    !Number.isSafeInteger(slotStartAddr)
    || slotStartAddr <= 0
    || slotStartAddr % WASM_PAGE_SIZE !== 0
  ) {
    throw new Error(`invalid pthread control slot address ${slotStartAddr}`);
  }
  const slotStartPage = slotStartAddr / WASM_PAGE_SIZE;
  const tlsOffset =
    (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
  const forkSaveOffset =
    (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE) * WASM_PAGE_SIZE;
  const channelOffset =
    (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
  return {
    slotStartPage,
    basePage: slotStartPage,
    tlsOffset,
    forkSaveOffset,
    channelOffset,
    tlsAllocAddr: tlsOffset,
  };
}

/**
 * Make a pthread control slot the kernel has placed usable by a thread.
 *
 * WHERE the slot goes is the kernel's decision: `sys_clone` reserves it from
 * the same address-space allocator that answers `mmap`, so it can see every
 * mapping, every other slot, and the brk heap. This host is told the address
 * (`kernel_thread_slot_addr`, or `kernel_reserve_host_region` for a control
 * slot outside the pthread quota) and does the two things only a host can do:
 * grow the process `WebAssembly.Memory` until the range is addressable, and
 * zero it.
 *
 * Both hosts previously carried their own placement arithmetic. The copies
 * disagreed -- a fixed 16-slot arena natively against dynamic reservations
 * here -- which made the native host's concurrent-thread ceiling its arena
 * size rather than the program's `__wasm_posix_thread_slots` declaration.
 */
export function materializeThreadSlot(
  memory: WebAssembly.Memory,
  slotStartAddr: number,
  ptrWidth: 4 | 8 = 4,
): ThreadAllocation {
  const slot = threadSlotOffsets(slotStartAddr);
  growMemoryToCover(memory, slotStartAddr + THREAD_SLOT_BYTES, ptrWidth);

  // Zero channel, TLS, and the per-thread fork save buffer.
  new Uint8Array(memory.buffer, slot.channelOffset, CH_TOTAL_SIZE).fill(0);
  new Uint8Array(memory.buffer, slot.tlsOffset, WASM_PAGE_SIZE).fill(0);
  new Uint8Array(memory.buffer, slot.forkSaveOffset, WASM_PAGE_SIZE).fill(0);
  new Uint8Array(memory.buffer, slot.forkSaveOffset, FORK_SAVE_BUFFER_SIZE).fill(0);

  return slot;
}
