import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";
import { FORK_SAVE_BUFFER_SIZE, growMemoryToCover } from "./process-memory";

export interface ThreadAllocation {
  /** Base page number (highest page of the thread's region) */
  basePage: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** Byte offset of the TLS region in Memory */
  tlsAllocAddr: number;
}

export interface ThreadPageAllocatorOptions {
  /** First page whose start address will hold a thread channel. */
  firstBasePage: number;
  /** Exclusive upper page bound for control-arena allocations. */
  maxPageExclusive: number;
  /** Pointer width of the process memory, used when growing memory64. */
  ptrWidth?: 4 | 8;
}

/**
 * Manages pthread channel/TLS allocation within a process WebAssembly.Memory.
 *
 * New process launches reserve a low control slab before the guest-managed
 * brk/mmap region. Allocations move upward from the main process channel
 * through fixed per-process slots, so pthread workers share the same SAB
 * without allocating control pages near the process maximum.
 *
 * Per-thread layout:
 *   basePage-2  - TLS page
 *   basePage-1  - gap page, including the fork save buffer below channel
 *   basePage    - channel start
 *   basePage+1  - channel spill
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];
  private readonly maxPageExclusive: number;
  private readonly direction: "up" | "down";
  private readonly ptrWidth: 4 | 8;

  constructor(options: ThreadPageAllocatorOptions);
  constructor(maxPages: number);
  constructor(options: ThreadPageAllocatorOptions | number) {
    if (typeof options === "number") {
      // Back-compatibility for existing external users of the old allocator.
      this.nextPage = options - 2 - PAGES_PER_THREAD;
      this.maxPageExclusive = options;
      this.direction = "down";
      this.ptrWidth = 4;
    } else {
      this.nextPage = options.firstBasePage;
      this.maxPageExclusive = options.maxPageExclusive;
      this.direction = "up";
      this.ptrWidth = options.ptrWidth ?? 4;
    }
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    let basePage: number;
    if (this.freePages.length > 0) {
      basePage = this.freePages.pop()!;
    } else {
      basePage = this.nextPage;
      if (this.direction === "up") {
        this.nextPage += PAGES_PER_THREAD;
      } else {
        this.nextPage -= PAGES_PER_THREAD;
      }
    }

    if (
      basePage < 2 ||
      basePage + Math.ceil(CH_TOTAL_SIZE / WASM_PAGE_SIZE) > this.maxPageExclusive
    ) {
      throw new Error("process control arena exhausted");
    }

    const channelOffset = basePage * WASM_PAGE_SIZE;
    const tlsAllocAddr = (basePage - 2) * WASM_PAGE_SIZE;
    growMemoryToCover(memory, channelOffset + CH_TOTAL_SIZE, this.ptrWidth);

    // Check if TLS page already has data (diagnostic: detect address space overlap)
    const preCheck = new DataView(memory.buffer);
    let nonZeroCount = 0;
    for (let i = 0; i < 64; i += 4) {
      if (preCheck.getUint32(tlsAllocAddr + i, true) !== 0) nonZeroCount++;
    }
    if (nonZeroCount > 0) {
      const vals: string[] = [];
      for (let i = 0; i < 64; i += 4) {
        vals.push(`0x${preCheck.getUint32(tlsAllocAddr + i, true).toString(16).padStart(8, '0')}`);
      }
      console.error(`[thread-alloc] WARNING: TLS page 0x${tlsAllocAddr.toString(16)} has ${nonZeroCount}/16 non-zero dwords BEFORE zeroing!`);
      console.error(`[thread-alloc]   data: ${vals.join(' ')}`);
    }

    // Zero channel, TLS, and the per-thread fork save buffer.
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsAllocAddr, WASM_PAGE_SIZE).fill(0);
    new Uint8Array(
      memory.buffer,
      channelOffset - FORK_SAVE_BUFFER_SIZE,
      FORK_SAVE_BUFFER_SIZE,
    ).fill(0);

    return { basePage, channelOffset, tlsAllocAddr };
  }

  /** Return pages to the free list after thread exit. */
  free(basePage: number): void {
    this.freePages.push(basePage);
  }
}
