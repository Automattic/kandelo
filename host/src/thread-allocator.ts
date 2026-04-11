import { CH_TOTAL_SIZE, WASM_PAGE_SIZE, PAGES_PER_THREAD } from "./constants";

export interface ThreadAllocation {
  /** Base page number (highest page of the thread's region) */
  basePage: number;
  /** Byte offset of the channel in Memory */
  channelOffset: number;
  /** Byte offset of the TLS region in Memory */
  tlsAllocAddr: number;
}

/**
 * Manages thread channel page allocation within a WebAssembly.Memory.
 *
 * Pages are allocated top-down: the main process channel sits at the top
 * two pages, and each thread gets PAGES_PER_THREAD pages counting downward.
 * Freed pages go to a free list for reuse.
 *
 * Per-thread layout (from basePage going down):
 *   basePage+1  — channel spill (40 bytes of header past 64 KiB boundary)
 *   basePage    — channel start (64 KiB data buffer)
 *   basePage-1  — gap page
 *   basePage-2  — TLS page
 * The spill page is absorbed by PAGES_PER_THREAD spacing between threads.
 */
export class ThreadPageAllocator {
  private nextPage: number;
  private freePages: number[] = [];

  constructor(maxPages: number) {
    // Main channel occupies top 2 pages; first thread region starts below
    this.nextPage = maxPages - 2 - PAGES_PER_THREAD;
  }

  /** Allocate pages for a new thread. Zeros the channel and TLS regions. */
  allocate(memory: WebAssembly.Memory): ThreadAllocation {
    let basePage: number;
    if (this.freePages.length > 0) {
      basePage = this.freePages.pop()!;
    } else {
      basePage = this.nextPage;
      this.nextPage -= PAGES_PER_THREAD;
    }

    const channelOffset = basePage * WASM_PAGE_SIZE;
    const tlsAllocAddr = (basePage - 2) * WASM_PAGE_SIZE;

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

    // Zero channel and TLS regions
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
    new Uint8Array(memory.buffer, tlsAllocAddr, WASM_PAGE_SIZE).fill(0);

    return { basePage, channelOffset, tlsAllocAddr };
  }

  /** Return pages to the free list after thread exit. */
  free(basePage: number): void {
    this.freePages.push(basePage);
  }
}
