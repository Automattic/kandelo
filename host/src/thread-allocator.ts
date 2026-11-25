import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD, extractGlobalConstants } from "./constants";
import { FORK_SAVE_BUFFER_SIZE, growMemoryToCover } from "./process-memory";
import { fillProcessBytes } from './process-memory-views';
import {
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE,
  PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE,
} from "./generated/abi";

export interface ThreadTlsRequirements {
  readonly byteLength: number;
  readonly alignment: number;
}

export interface ThreadTlsAllocation {
  readonly offset: number;
  readonly byteLength: number;
}

/** Decode the executable's linker-defined TLS layout before starting a pthread. */
export function readThreadTlsRequirements(programBytes: ArrayBuffer): ThreadTlsRequirements {
  const globals = extractGlobalConstants(programBytes, ["__tls_size", "__tls_align"], true);
  const size = globals.get("__tls_size");
  const align = globals.get("__tls_align");
  if (size === undefined && align === undefined) {
    // Binaries predating these exports keep the ABI's original TLS page.
    return { byteLength: WASM_PAGE_SIZE, alignment: 1 };
  }
  if (
    typeof size !== "bigint" || typeof align !== "bigint"
    || size > BigInt(Number.MAX_SAFE_INTEGER) || align > BigInt(Number.MAX_SAFE_INTEGER)
    || align === 0n || (align & (align - 1n)) !== 0n
  ) {
    throw new Error("invalid executable TLS size or alignment exports");
  }
  return { byteLength: Number(size), alignment: Number(align) };
}

export interface ThreadAllocation {
  /** Start page of the pthread slot. */
  slotStartPage: number;
  /** @deprecated Use slotStartPage. */
  basePage: number;
  /** Byte offset of the control page reserved by the current ABI. */
  controlOffset: number;
  /** Pthread TLS address and capacity for __wasm_init_tls. */
  tls: ThreadTlsAllocation;
  /** @deprecated Use tls.offset, or controlOffset for host-only scratch. */
  tlsOffset: number;
  /** Full reservation length, including any out-of-line TLS and alignment padding. */
  slotByteLength: number;
  /** Byte offset of the per-thread fork-save/scratch page in Memory. */
  forkSaveOffset: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** @deprecated Use tls.offset. */
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
  reserveSlotStartPage?: (byteLength: number) => number;
  tlsRequirements?: ThreadTlsRequirements;
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
  private freeLargeTlsPages: number[] = [];
  private readonly maxPageExclusive: number;
  private readonly direction: "up" | "down";
  private readonly ptrWidth: 4 | 8;
  private readonly reservedSlots: number;
  private readonly reserveSlotStartPage?: (byteLength: number) => number;
  readonly tlsRequirements: ThreadTlsRequirements;
  private readonly threadSlotByteLength: number;
  private activeCount = 0;
  private readonly hostControlPages = new Set<number>();

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
    this.tlsRequirements = (typeof options === "number" ? undefined : options.tlsRequirements) ?? {
      byteLength: WASM_PAGE_SIZE, alignment: 1,
    };
    const { byteLength, alignment } = this.tlsRequirements;
    const controlBytes = PAGES_PER_THREAD * WASM_PAGE_SIZE;
    const extraBytes = byteLength <= WASM_PAGE_SIZE && alignment <= WASM_PAGE_SIZE ? 0
      : Math.ceil((byteLength + Math.max(0, alignment - WASM_PAGE_SIZE)) / WASM_PAGE_SIZE)
        * WASM_PAGE_SIZE;
    this.threadSlotByteLength = controlBytes + extraBytes;
    if (!Number.isSafeInteger(this.threadSlotByteLength)) {
      throw new Error("executable TLS reservation exceeds the supported address range");
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    return this.allocateSlot(memory, false);
  }

  assertCanAllocate(): void {
    if (this.activeCount >= this.reservedSlots) {
      throw new RangeError(`process pthread slot limit exhausted (limit=${this.reservedSlots}, active=${this.activeCount})`);
    }
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
    hostControl: boolean,
  ): ThreadAllocation {
    if (!hostControl) this.assertCanAllocate();

    const controlBytes = PAGES_PER_THREAD * WASM_PAGE_SIZE;
    const slotByteLength = hostControl ? controlBytes : this.threadSlotByteLength;
    const largeTls = slotByteLength > controlBytes;
    const freePages = largeTls ? this.freeLargeTlsPages : this.freePages;
    let slotStartPage: number;
    if (freePages.length > 0) {
      slotStartPage = freePages[freePages.length - 1]!;
    } else if (this.reserveSlotStartPage) {
      slotStartPage = this.reserveSlotStartPage(slotByteLength);
    } else {
      if (largeTls) throw new Error("large executable TLS requires a dynamic host reservation");
      slotStartPage = this.nextPage;
    }

    if (!this.reserveSlotStartPage && (
      slotStartPage < 0 ||
      slotStartPage + PAGES_PER_THREAD > this.maxPageExclusive
    )) {
      throw new RangeError(
        `process pthread slot limit exhausted (limit=${this.reservedSlots}, ` +
          `active=${this.activeCount}). Rebuild with --kandelo-thread-slots=N ` +
          "or increase the host defaultThreadSlots setting.",
      );
    }

    const controlOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
    const { byteLength, alignment } = this.tlsRequirements;
    const tlsOffset = largeTls
      ? Math.ceil((slotStartPage * WASM_PAGE_SIZE + controlBytes) / alignment) * alignment
      : controlOffset;
    const tls = { offset: tlsOffset, byteLength: hostControl ? WASM_PAGE_SIZE : byteLength };
    const forkSaveOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_FORK_SAVE_PAGE) * WASM_PAGE_SIZE;
    const channelOffset =
      (slotStartPage + PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
    try {
      growMemoryToCover(memory, slotStartPage * WASM_PAGE_SIZE + slotByteLength, this.ptrWidth);
    } catch (error) {
      // Keep an already reserved native interval available for a later retry.
      // Reused slots have not been removed from their free list yet.
      if (this.reserveSlotStartPage && freePages.length === 0) freePages.push(slotStartPage);
      throw error;
    }

    // Zero channel, TLS, and the per-thread fork save buffer.
    fillProcessBytes(memory, channelOffset, CH_TOTAL_SIZE, 0);
    fillProcessBytes(memory, controlOffset, WASM_PAGE_SIZE, 0);
    if (largeTls) fillProcessBytes(memory, tls.offset, tls.byteLength, 0);
    fillProcessBytes(memory, forkSaveOffset, WASM_PAGE_SIZE, 0);
    fillProcessBytes(memory, forkSaveOffset, FORK_SAVE_BUFFER_SIZE, 0);

    if (freePages.length > 0) freePages.pop();
    else if (!this.reserveSlotStartPage) this.nextPage += this.direction === 'up' ? PAGES_PER_THREAD : -PAGES_PER_THREAD;

    if (hostControl) this.hostControlPages.add(slotStartPage);
    else this.activeCount++;
    return {
      slotStartPage,
      basePage: slotStartPage,
      controlOffset,
      slotByteLength,
      tls,
      tlsOffset,
      forkSaveOffset,
      channelOffset,
      tlsAllocAddr: tlsOffset,
    };
  }

  /** Return pages to the free list after thread exit. */
  free(slotStartPage: number): void {
    const hostControl = this.hostControlPages.delete(slotStartPage);
    const largeTls = !hostControl && this.threadSlotByteLength > PAGES_PER_THREAD * WASM_PAGE_SIZE;
    (largeTls ? this.freeLargeTlsPages : this.freePages).push(slotStartPage);
    if (!hostControl) {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }
}
