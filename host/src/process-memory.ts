import {
  CH_TOTAL_SIZE,
  DEFAULT_MAX_PAGES,
  WASM_PAGE_SIZE,
} from "./constants";

/** Kernel MemoryManager::MMAP_BASE. Guest mmap allocations start here. */
export const PROCESS_MMAP_BASE = 0x04000000;
export const PROCESS_MMAP_BASE_PAGE = PROCESS_MMAP_BASE / WASM_PAGE_SIZE;

/** Kernel MemoryManager::INITIAL_BRK fallback for binaries without __heap_base. */
export const PROCESS_FALLBACK_BRK_BASE = 0x01000000;

/**
 * Keep a modest brk window below the host control arena. Larger allocations
 * still use mmap above PROCESS_MMAP_BASE and grow the WebAssembly.Memory on
 * demand.
 */
export const DEFAULT_BRK_RESERVE_PAGES = 256; // 16 MiB

export const DEFAULT_PROCESS_INITIAL_PAGES = 17;
export const FORK_SAVE_BUFFER_SIZE = 16 * 1024;
export const CHANNEL_PAGES = Math.ceil(CH_TOTAL_SIZE / WASM_PAGE_SIZE);

export interface ProcessMemoryLayout {
  /** Initial WebAssembly.Memory pages required for the main channel. */
  initialPages: number;
  /** Maximum pages configured for this process. */
  maximumPages: number;
  /** Main thread syscall channel byte offset. */
  channelOffset: number;
  /** Page containing the main thread syscall channel header. */
  channelPage: number;
  /** Highest brk address permitted before colliding with host control pages. */
  brkLimit: number;
  /** Highest mmap address permitted by the process memory maximum. */
  maxAddr: number;
  /** First thread channel base page in the low control arena. */
  firstThreadBasePage: number;
  /** Exclusive page limit for low control arena thread allocations. */
  threadArenaEndPage: number;
}

export interface ProcessMemoryLayoutOptions {
  maxPages?: number;
  ptrWidth: 4 | 8;
  programBytes?: ArrayBuffer;
  heapBase?: bigint | number | null;
  minPages?: number;
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
  const brkBase = Math.max(
    heapBase ?? PROCESS_FALLBACK_BRK_BASE,
    minPages * WASM_PAGE_SIZE,
  );

  const reservePages = options.brkReservePages ?? DEFAULT_BRK_RESERVE_PAGES;
  const desiredBrkLimit = pageAlignUp(brkBase + reservePages * WASM_PAGE_SIZE);

  const arenaEndPage = Math.min(maximumPages, PROCESS_MMAP_BASE_PAGE);
  const maxMainChannelPage = arenaEndPage - CHANNEL_PAGES;
  if (maxMainChannelPage <= 0) {
    throw new Error(`maxPages=${maximumPages} leaves no room for a syscall channel`);
  }

  const maxBrkLimit = maxMainChannelPage * WASM_PAGE_SIZE - FORK_SAVE_BUFFER_SIZE;
  if (brkBase > maxBrkLimit) {
    throw new Error(
      `program brk base 0x${brkBase.toString(16)} does not fit below process control arena ` +
        `(max brk 0x${maxBrkLimit.toString(16)})`,
    );
  }

  const brkLimitTarget = Math.min(desiredBrkLimit, maxBrkLimit);
  const channelPage = Math.ceil((brkLimitTarget + FORK_SAVE_BUFFER_SIZE) / WASM_PAGE_SIZE);
  const channelOffset = channelPage * WASM_PAGE_SIZE;
  const brkLimit = channelOffset - FORK_SAVE_BUFFER_SIZE;
  const initialPages = Math.max(
    minPages,
    Math.ceil((channelOffset + CH_TOTAL_SIZE) / WASM_PAGE_SIZE),
  );

  if (initialPages > maximumPages) {
    throw new Error(
      `initial pages ${initialPages} exceed process maximum ${maximumPages}`,
    );
  }

  return {
    initialPages,
    maximumPages,
    channelOffset,
    channelPage,
    brkLimit,
    maxAddr: maximumPages * WASM_PAGE_SIZE,
    firstThreadBasePage: channelPage + 4,
    threadArenaEndPage: arenaEndPage,
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
