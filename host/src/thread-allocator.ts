import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";
import { FORK_SAVE_BUFFER_SIZE, growMemoryToCover } from "./process-memory";
import {
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
} from "./generated/abi";

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

export interface ThreadPageAllocatorOptions {
  /** First page whose start address begins a pthread slot. */
  firstSlotStartPage?: number;
  /** @deprecated First page whose start address holds a thread channel. */
  firstBasePage?: number;
  /** Exclusive upper page bound for control-arena allocations. */
  maxPageExclusive: number;
  /** Pointer width of the process memory, used when growing memory64. */
  ptrWidth?: 4 | 8;
  /** Reserved slot count used in exhaustion diagnostics. */
  reservedSlots?: number;
}

/**
 * Manages pthread channel/TLS allocation within a process WebAssembly.Memory.
 *
 * New process launches reserve a low control slab before the guest-managed
 * brk/mmap region. Allocations move upward from the main process channel
 * through fixed per-process slots, so pthread workers share the same SAB
 * without allocating control pages near the process maximum.
 *
 * Per-thread slot layout:
 *   slotStart+0 - TLS/control page
 *   slotStart+1 - fork-save/scratch page
 *   slotStart+2 - syscall channel primary page
 *   slotStart+3 - syscall channel spill page
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];
  private readonly maxPageExclusive: number;
  private readonly direction: "up" | "down";
  private readonly ptrWidth: 4 | 8;
  private readonly reservedSlots: number;
  private activeCount = 0;

  constructor(options: ThreadPageAllocatorOptions);
  constructor(maxPages: number);
  constructor(options: ThreadPageAllocatorOptions | number) {
    if (typeof options === "number") {
      // Back-compatibility for existing external users of the old allocator.
      this.nextPage =
        options - 2 - PAGES_PER_THREAD - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE;
      this.maxPageExclusive = options;
      this.direction = "down";
      this.ptrWidth = 4;
      this.reservedSlots = Math.max(0, Math.floor(options / PAGES_PER_THREAD));
    } else {
      if (options.firstSlotStartPage !== undefined) {
        this.nextPage = options.firstSlotStartPage;
      } else if (options.firstBasePage !== undefined) {
        this.nextPage =
          options.firstBasePage - PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE;
      } else {
        throw new Error("ThreadPageAllocator requires firstSlotStartPage");
      }
      this.maxPageExclusive = options.maxPageExclusive;
      this.direction = "up";
      this.ptrWidth = options.ptrWidth ?? 4;
      this.reservedSlots = options.reservedSlots ?? Math.max(
        0,
        Math.floor((this.maxPageExclusive - this.nextPage) / PAGES_PER_THREAD),
      );
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    let slotStartPage: number;
    if (this.freePages.length > 0) {
      slotStartPage = this.freePages.pop()!;
    } else {
      slotStartPage = this.nextPage;
      if (this.direction === "up") {
        this.nextPage += PAGES_PER_THREAD;
      } else {
        this.nextPage -= PAGES_PER_THREAD;
      }
    }

    if (
      slotStartPage < 0 ||
      slotStartPage + PAGES_PER_THREAD > this.maxPageExclusive
    ) {
      throw new Error(
        `process reserved pthread slots exhausted (reserved=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    const tlsOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
    const forkSaveOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE) * WASM_PAGE_SIZE;
    const channelOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
    growMemoryToCover(
      memory,
      (slotStartPage + PAGES_PER_THREAD) * WASM_PAGE_SIZE,
      this.ptrWidth,
    );

    // Check if TLS page already has data (diagnostic: detect address space overlap)
    const preCheck = new DataView(memory.buffer);
    let nonZeroCount = 0;
    for (let i = 0; i < 64; i += 4) {
      if (preCheck.getUint32(tlsOffset + i, true) !== 0) nonZeroCount++;
    }
    if (nonZeroCount > 0) {
      const vals: string[] = [];
      for (let i = 0; i < 64; i += 4) {
        vals.push(`0x${preCheck.getUint32(tlsOffset + i, true).toString(16).padStart(8, '0')}`);
      }
      console.error(`[thread-alloc] WARNING: TLS page 0x${tlsOffset.toString(16)} has ${nonZeroCount}/16 non-zero dwords BEFORE zeroing!`);
      console.error(`[thread-alloc]   data: ${vals.join(' ')}`);
    }

    // Zero channel, TLS, and the per-thread fork save buffer.
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, FORK_SAVE_BUFFER_SIZE).fill(0);

    this.activeCount++;
    return {
      slotStartPage,
      basePage: slotStartPage,
      tlsOffset,
      forkSaveOffset,
      channelOffset,
      tlsAllocAddr: tlsOffset,
    };
  }

  /** Return pages to the free list after thread exit. */
  free(slotStartPage: number): void {
    this.freePages.push(slotStartPage);
    this.activeCount = Math.max(0, this.activeCount - 1);
  }
}
