import {
  CH_TOTAL_SIZE,
  DEFAULT_MAX_PAGES,
  PAGES_PER_THREAD,
  WASM_PAGE_SIZE,
} from "./constants";

/** Legacy Kernel MemoryManager::MMAP_BASE. Compact hosts override this per process. */
export const PROCESS_MMAP_BASE = 0x04000000;
export const PROCESS_MMAP_BASE_PAGE = PROCESS_MMAP_BASE / WASM_PAGE_SIZE;

/** Kernel MemoryManager::INITIAL_BRK fallback for binaries without __heap_base. */
export const PROCESS_FALLBACK_BRK_BASE = 0x01000000;

/** @deprecated brk and mmap are now coordinated by the kernel allocator. */
export const DEFAULT_BRK_RESERVE_PAGES = 256; // 16 MiB

export const DEFAULT_PROCESS_INITIAL_PAGES = 17;
export const DEFAULT_PROCESS_THREAD_SLOTS = 16;
export const FORK_SAVE_BUFFER_SIZE = 16 * 1024;
export const CHANNEL_PAGES = Math.ceil(CH_TOTAL_SIZE / WASM_PAGE_SIZE);

export interface ProcessMemoryLayout {
  /** Initial WebAssembly.Memory pages required for the low control slab. */
  initialPages: number;
  /** Maximum pages configured for this process. */
  maximumPages: number;
  /** First byte of host-owned control memory after linker-owned data. */
  controlBase: number;
  /** First guest-managed byte after the host-owned control slab. */
  controlEnd: number;
  /** Main thread syscall channel byte offset. */
  channelOffset: number;
  /** Page containing the main thread syscall channel header. */
  channelPage: number;
  /** Initial program break after host-owned control pages. */
  brkBase: number;
  /** Lower bound for automatic mmap allocation. */
  mmapBase: number;
  /** Highest brk address permitted; legacy compatibility field. */
  brkLimit: number;
  /** Highest mmap address permitted by the process memory maximum. */
  maxAddr: number;
  /** First thread channel base page in the low control slab. */
  firstThreadBasePage: number;
  /** Exclusive page limit for low control slab thread allocations. */
  threadArenaEndPage: number;
  /** Number of pthread control slots reserved in this process memory. */
  threadSlotCount: number;
}

export interface ProcessMemoryLayoutOptions {
  maxPages?: number;
  ptrWidth: 4 | 8;
  programBytes?: ArrayBuffer;
  heapBase?: bigint | number | null;
  minPages?: number;
  threadSlots?: number;
  /** @deprecated brk and mmap are coordinated by the kernel allocator. */
  brkReservePages?: number;
}

function readULEB(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = off;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated wasm LEB128");
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos - off];
}

function ulebNumber(buf: Uint8Array, off: number): [number, number] {
  const [value, len] = readULEB(buf, off);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`wasm LEB128 value exceeds JS safe integer: ${value}`);
  }
  return [Number(value), len];
}

function skipLimits(buf: Uint8Array, off: number): number {
  const [flags, flagsLen] = ulebNumber(buf, off);
  let pos = off + flagsLen;
  const [, minLen] = readULEB(buf, pos);
  pos += minLen;
  if ((flags & 0x01) !== 0) {
    const [, maxLen] = readULEB(buf, pos);
    pos += maxLen;
  }
  return pos;
}

/**
 * Return the imported memory's minimum page count, or null when the binary has
 * no memory import. Supports both memory32 and memory64 limit encodings.
 */
export function importedMemoryMinimumPages(wasmBytes: ArrayBuffer): number | null {
  const buf = new Uint8Array(wasmBytes);
  if (
    buf.length < 8 ||
    buf[0] !== 0x00 ||
    buf[1] !== 0x61 ||
    buf[2] !== 0x73 ||
    buf[3] !== 0x6d
  ) {
    return null;
  }

  let off = 8;
  while (off < buf.length) {
    const sectionId = buf[off++];
    const [sectionSize, sectionSizeLen] = ulebNumber(buf, off);
    off += sectionSizeLen;
    const sectionEnd = off + sectionSize;

    if (sectionId !== 2) {
      off = sectionEnd;
      continue;
    }

    const [importCount, importCountLen] = ulebNumber(buf, off);
    off += importCountLen;
    for (let i = 0; i < importCount; i++) {
      const [moduleLen, moduleLenBytes] = ulebNumber(buf, off);
      off += moduleLenBytes + moduleLen;
      const [nameLen, nameLenBytes] = ulebNumber(buf, off);
      off += nameLenBytes + nameLen;
      const kind = buf[off++];

      if (kind === 0x00) {
        const [, typeLen] = ulebNumber(buf, off);
        off += typeLen;
      } else if (kind === 0x01) {
        off += 1; // elemtype
        off = skipLimits(buf, off);
      } else if (kind === 0x02) {
        const [, flagsLen] = ulebNumber(buf, off);
        off += flagsLen;
        const [minPages] = ulebNumber(buf, off);
        return minPages;
      } else if (kind === 0x03) {
        off += 2; // valtype + mutability
      } else if (kind === 0x04) {
        off += 1; // tag attribute
        const [, typeLen] = ulebNumber(buf, off);
        off += typeLen;
      } else {
        return null;
      }
    }
    return null;
  }

  return null;
}

function pageAlignUp(bytes: number): number {
  return Math.ceil(bytes / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
}

function heapBaseToNumber(heapBase: bigint | number | null | undefined): number | null {
  if (heapBase == null) return null;
  if (typeof heapBase === "bigint") {
    if (heapBase > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`heap base exceeds JS safe integer: ${heapBase}`);
    }
    return Number(heapBase);
  }
  return heapBase;
}

export function computeProcessMemoryLayout(
  options: ProcessMemoryLayoutOptions,
): ProcessMemoryLayout {
  const maximumPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maximumPages) || maximumPages <= CHANNEL_PAGES) {
    throw new Error(`invalid process maximum pages: ${maximumPages}`);
  }

  const importedMinPages = options.programBytes
    ? importedMemoryMinimumPages(options.programBytes) ?? 0
    : 0;
  const minPages = Math.max(
    DEFAULT_PROCESS_INITIAL_PAGES,
    options.minPages ?? 0,
    importedMinPages,
  );

  const heapBase = heapBaseToNumber(options.heapBase);
  const firstFreeByte = Math.max(
    heapBase ?? PROCESS_FALLBACK_BRK_BASE,
    minPages * WASM_PAGE_SIZE,
  );
  const controlBase = pageAlignUp(firstFreeByte);
  const controlBasePage = controlBase / WASM_PAGE_SIZE;

  const threadSlotCount = options.threadSlots ?? DEFAULT_PROCESS_THREAD_SLOTS;
  if (!Number.isInteger(threadSlotCount) || threadSlotCount < 0) {
    throw new Error(`invalid process thread slot count: ${threadSlotCount}`);
  }

  // Main thread layout:
  //   controlBasePage   - main fork save buffer at the end of the page
  //   channelPage       - main syscall channel header/data
  //   channelPage+1     - channel spill page
  //
  // Thread slots then use the existing ThreadPageAllocator contract:
  //   basePage-2        - TLS page
  //   basePage-1        - per-thread fork save buffer page
  //   basePage          - thread syscall channel
  //   basePage+1        - channel spill page
  const channelPage = controlBasePage + 1;
  const channelOffset = channelPage * WASM_PAGE_SIZE;
  const firstThreadBasePage = channelPage + CHANNEL_PAGES + 2;
  const threadArenaEndPage = threadSlotCount === 0
    ? channelPage + CHANNEL_PAGES
    : firstThreadBasePage + (threadSlotCount - 1) * PAGES_PER_THREAD + CHANNEL_PAGES;

  const initialPages = Math.max(
    minPages,
    threadArenaEndPage,
  );

  if (initialPages > maximumPages) {
    throw new Error(
      `initial pages ${initialPages} exceed process maximum ${maximumPages}`,
    );
  }

  const brkBase = threadArenaEndPage * WASM_PAGE_SIZE;
  const maxAddr = maximumPages * WASM_PAGE_SIZE;

  return {
    initialPages,
    maximumPages,
    controlBase,
    controlEnd: brkBase,
    channelOffset,
    channelPage,
    brkBase,
    mmapBase: brkBase,
    brkLimit: maxAddr,
    maxAddr,
    firstThreadBasePage,
    threadArenaEndPage,
    threadSlotCount,
  };
}

export function createProcessMemory(
  ptrWidth: 4 | 8,
  layout: ProcessMemoryLayout,
): WebAssembly.Memory {
  if (ptrWidth === 8) {
    return new WebAssembly.Memory({
      initial: BigInt(layout.initialPages) as any,
      maximum: BigInt(layout.maximumPages) as any,
      shared: true,
      address: "i64",
    } as any);
  }
  return new WebAssembly.Memory({
    initial: layout.initialPages,
    maximum: layout.maximumPages,
    shared: true,
  });
}

export function growMemoryToCover(
  memory: WebAssembly.Memory,
  endOffset: number,
  ptrWidth: 4 | 8 = 4,
): void {
  const requiredPages = Math.ceil(endOffset / WASM_PAGE_SIZE);
  const currentPages = Math.ceil(memory.buffer.byteLength / WASM_PAGE_SIZE);
  const delta = requiredPages - currentPages;
  if (delta <= 0) return;
  if (ptrWidth === 8) {
    memory.grow(BigInt(delta) as any);
  } else {
    memory.grow(delta);
  }
}
