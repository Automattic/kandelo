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
  /** Maximum concurrent pthread slots for this process. */
  reservedSlots?: number;
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
  private readonly reserveSlotStartPage?: () => number;

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
      this.reservedSlots = options.reservedSlots ?? Math.max(
        0,
        Math.floor((this.maxPageExclusive - this.nextPage) / PAGES_PER_THREAD),
      );
      this.reserveSlotStartPage = options.reserveSlotStartPage;
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    return this.allocateSlot(memory, false);
  }

  /**
   * Allocate a host-owned control slot outside the guest pthread quota.
   *
   * WHY: a single-threaded executable can truthfully declare zero pthread
   * slots and still call vfork. Its borrowing child needs an independent
   * syscall channel, replay prefix, and scratch page, but that platform state
   * must neither require nor consume capacity promised to pthread_create.
   */
  allocateHostControl(memory: WebAssembly.Memory): ThreadAllocation {
    return this.allocateSlot(memory, true);
  }

  private allocateSlot(
    memory: WebAssembly.Memory,
    _hostControl: boolean,
  ): ThreadAllocation {
    // The concurrent-pthread ceiling is NOT enforced here. The kernel refuses
    // `clone` with EAGAIN once a process holds `reservedSlots` live threads,
    // and it does so before allocating a tid -- which is what POSIX requires
    // of a failed `pthread_create` and what this check could never provide,
    // because it runs after `kernel_clone` has already succeeded. The quota is
    // published to the kernel by `registerProcess`'s `threadSlotQuota`; this
    // allocator is placement only.
    let slotStartPage: number;
    if (this.freePages.length > 0) {
      slotStartPage = this.freePages.pop()!;
    } else if (this.reserveSlotStartPage) {
      slotStartPage = this.reserveSlotStartPage();
    } else {
      slotStartPage = this.nextPage;
      if (this.direction === "up") {
        this.nextPage += PAGES_PER_THREAD;
      } else {
        this.nextPage -= PAGES_PER_THREAD;
      }
    }

    // A static arena that has run out of address space is a host defect, not a
    // resource limit: the kernel already refused anything past the declared
    // concurrent ceiling, so reaching this means the arena and the quota have
    // drifted apart. Fail loudly rather than reporting it as EAGAIN, which
    // would tell a guest to retry something that can never succeed.
    if (!this.reserveSlotStartPage && (
      slotStartPage < 0 ||
      slotStartPage + PAGES_PER_THREAD > this.maxPageExclusive
    )) {
      throw new Error(
        `pthread slot arena exhausted at page ${slotStartPage} despite the ` +
          `kernel's concurrent-thread quota (${this.reservedSlots}); the quota ` +
          "and the arena have drifted apart.",
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

    // Zero channel, TLS, and the per-thread fork save buffer.
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(memory.buffer, forkSaveOffset, FORK_SAVE_BUFFER_SIZE).fill(0);

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
   * Return pages to the free list after thread exit.
   *
   * POSIX counts threads that exist now, so a joined thread's slot has to
   * become available again immediately; without this the arena would be a
   * budget spent once per thread ever created.
   */
  free(slotStartPage: number): void {
    this.freePages.push(slotStartPage);
  }
}
