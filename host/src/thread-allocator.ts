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
  /** Address passed to wpk_fork_unwind_begin / rewind_begin for this thread. */
  forkBufAddr: number;
  /** Usable fork save buffer size for this thread. */
  forkSaveBufferSize: number;
  /** Total byte span of the thread control slot. */
  slotLen: number;
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
  /** Maximum concurrent pthread slots for this process. */
  reservedSlots?: number;
  /** Usable fork save buffer size for each slot. */
  forkSaveBufferSize?: number;
  /** Whole pages reserved for the usable fork save buffer. */
  forkSaveBufferPages?: number;
  /** Spare pages below the usable fork buffer for host control slots. */
  forkSaveSparePages?: number;
  /** Total pages consumed by each pthread control slot. */
  pagesPerSlot?: number;
  /** Dynamically reserve a fresh pthread slot start page when no free slot exists. */
  reserveSlotStartPage?: () => number;
}

/**
 * Manages pthread channel/TLS allocation within a process WebAssembly.Memory.
 *
 * New process launches reserve only the main-thread control pages. Pthread
 * slots are either allocated from a fixed compatibility arena or dynamically
 * reserved in the process address space by the kernel worker.
 *
 * Per-thread slot layout:
 *   slotStart+0 - TLS/control page
 *   slotStart+1.. - optional spare page(s), then fork-save buffer pages
 *   slotStart+N - syscall channel primary page
 *   slotStart+N+1 - syscall channel spill page
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];
  private readonly maxPageExclusive: number;
  private readonly direction: "up" | "down";
  private readonly ptrWidth: 4 | 8;
  private readonly reservedSlots: number;
  private readonly forkSaveBufferSize: number;
  private readonly forkSaveBufferPages: number;
  private readonly forkSaveSparePages: number;
  private readonly pagesPerSlot: number;
  private readonly reserveSlotStartPage?: () => number;
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
      this.forkSaveBufferSize = FORK_SAVE_BUFFER_SIZE;
      this.forkSaveBufferPages = 1;
      this.forkSaveSparePages = 0;
      this.pagesPerSlot = PAGES_PER_THREAD;
      this.reserveSlotStartPage = undefined;
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
      this.forkSaveBufferSize = options.forkSaveBufferSize ?? FORK_SAVE_BUFFER_SIZE;
      this.forkSaveBufferPages =
        options.forkSaveBufferPages ?? Math.max(1, Math.ceil(this.forkSaveBufferSize / WASM_PAGE_SIZE));
      this.forkSaveSparePages = options.forkSaveSparePages ?? 0;
      this.pagesPerSlot =
        options.pagesPerSlot ?? (1 + this.forkSaveSparePages + this.forkSaveBufferPages + Math.ceil(CH_TOTAL_SIZE / WASM_PAGE_SIZE));
      this.reservedSlots = options.reservedSlots ?? Math.max(
        0,
        Math.floor((this.maxPageExclusive - this.nextPage) / this.pagesPerSlot),
      );
      this.reserveSlotStartPage = options.reserveSlotStartPage;
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    if (this.activeCount >= this.reservedSlots) {
      throw new Error(
        `process pthread slot limit exhausted (limit=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    let slotStartPage: number;
    if (this.freePages.length > 0) {
      slotStartPage = this.freePages.pop()!;
    } else if (this.reserveSlotStartPage) {
      slotStartPage = this.reserveSlotStartPage();
    } else {
      slotStartPage = this.nextPage;
      if (this.direction === "up") {
        this.nextPage += this.pagesPerSlot;
      } else {
        this.nextPage -= this.pagesPerSlot;
      }
    }

    if (!this.reserveSlotStartPage && (
      slotStartPage < 0 ||
      slotStartPage + this.pagesPerSlot > this.maxPageExclusive
    )) {
      throw new Error(
        `process pthread slot limit exhausted (limit=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    const tlsOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
    const forkSaveOffset =
      (
        slotStartPage +
        PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE +
        this.forkSaveSparePages
      ) * WASM_PAGE_SIZE;
    const channelOffset =
      (
        slotStartPage +
        1 +
        this.forkSaveSparePages +
        this.forkSaveBufferPages
      ) * WASM_PAGE_SIZE;
    const forkBufAddr = channelOffset - this.forkSaveBufferSize;
    growMemoryToCover(
      memory,
      (slotStartPage + this.pagesPerSlot) * WASM_PAGE_SIZE,
      this.ptrWidth,
    );

    // Zero channel, TLS, and the per-thread fork save buffer.
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(
      memory.buffer,
      slotStartPage * WASM_PAGE_SIZE,
      this.pagesPerSlot * WASM_PAGE_SIZE,
    ).fill(0);

    this.activeCount++;
    return {
      slotStartPage,
      basePage: slotStartPage,
      tlsOffset,
      forkSaveOffset,
      forkBufAddr,
      forkSaveBufferSize: this.forkSaveBufferSize,
      slotLen: this.pagesPerSlot * WASM_PAGE_SIZE,
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
