import {
  CH_TOTAL_SIZE,
  DEFAULT_MAX_PAGES,
  extractThreadSlotDeclaration,
  WASM_PAGE_SIZE,
} from "./constants";
import {
  PROCESS_MEMORY_DEFAULT_INITIAL_PAGES,
  PROCESS_MEMORY_DEFAULT_THREAD_SLOTS,
  PROCESS_MEMORY_FALLBACK_BRK_BASE,
  PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE,
  PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE,
  PROCESS_MEMORY_LEGACY_MMAP_BASE,
  PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE,
  PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT,
} from "./generated/abi";

/** Legacy Kernel MemoryManager::MMAP_BASE. Compact hosts override this per process. */
export const PROCESS_MMAP_BASE = PROCESS_MEMORY_LEGACY_MMAP_BASE;
export const PROCESS_MMAP_BASE_PAGE = PROCESS_MMAP_BASE / WASM_PAGE_SIZE;

/** Kernel MemoryManager::INITIAL_BRK fallback for binaries without __heap_base. */
export const PROCESS_FALLBACK_BRK_BASE = PROCESS_MEMORY_FALLBACK_BRK_BASE;

/** @deprecated brk and mmap are now coordinated by the kernel allocator. */
export const DEFAULT_BRK_RESERVE_PAGES = 256; // 16 MiB

export const DEFAULT_PROCESS_INITIAL_PAGES = PROCESS_MEMORY_DEFAULT_INITIAL_PAGES;
export const DEFAULT_PROCESS_THREAD_SLOTS = PROCESS_MEMORY_DEFAULT_THREAD_SLOTS;
export const PROCESS_THREAD_SLOTS_USE_HOST_DEFAULT =
  PROCESS_MEMORY_THREAD_SLOTS_USE_HOST_DEFAULT;
export const FORK_SAVE_BUFFER_SIZE = PROCESS_MEMORY_FORK_SAVE_BUFFER_SIZE;
export const FORK_SAVE_CONTROL_PREFIX_SIZE = PROCESS_MEMORY_FORK_SAVE_CONTROL_PREFIX_SIZE;
export const CHANNEL_PAGES = Math.ceil(CH_TOTAL_SIZE / WASM_PAGE_SIZE);

export interface ProcessMemoryLayout {
  /** Initial WebAssembly.Memory pages required before user code starts. */
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
  /** First page after the main control area; dynamic pthread slots may start here. */
  firstThreadSlotPage: number;
  /** @deprecated Use firstThreadSlotPage or per-slot channel offsets. */
  firstThreadBasePage: number;
  /** Exclusive page limit for preallocated thread allocations. */
  threadArenaEndPage: number;
  /** Maximum concurrent pthread slots for this process. */
  threadSlotCount: number;
}

export interface ProcessMemoryLayoutOptions {
  maxPages?: number;
  ptrWidth: 4 | 8;
  programBytes?: ArrayBuffer;
  heapBase?: bigint | number | null;
  minPages?: number;
  /** Host default used when the process-wasm declaration is -1 or absent. */
  defaultThreadSlots?: number;
  /** Explicit exact pthread slot count; bypasses the process-wasm declaration. */
  threadSlots?: number;
  /** Preallocate the full pthread control slab. Defaults to dynamic slots. */
  preallocateThreadSlots?: boolean;
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

function validateThreadSlotCount(threadSlotCount: number, label: string): number {
  if (!Number.isInteger(threadSlotCount) || threadSlotCount < 0) {
    throw new Error(`invalid ${label}: ${threadSlotCount}`);
  }
  return threadSlotCount;
}

export function resolveProcessThreadSlotCount(
  programBytes: ArrayBuffer | undefined,
  hostDefaultThreadSlots: number = DEFAULT_PROCESS_THREAD_SLOTS,
): number {
  validateThreadSlotCount(hostDefaultThreadSlots, "host default thread slot count");

  const declared = programBytes ? extractThreadSlotDeclaration(programBytes) : null;
  if (declared === null || declared === PROCESS_THREAD_SLOTS_USE_HOST_DEFAULT) {
    return hostDefaultThreadSlots;
  }
  if (!Number.isInteger(declared) || declared < PROCESS_THREAD_SLOTS_USE_HOST_DEFAULT) {
    throw new Error(`invalid process thread slot declaration: ${declared}`);
  }
  return validateThreadSlotCount(declared, "process thread slot declaration");
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

  const threadSlotCount = options.threadSlots !== undefined
    ? validateThreadSlotCount(options.threadSlots, "process thread slot count")
    : resolveProcessThreadSlotCount(options.programBytes, options.defaultThreadSlots);

  // Main thread layout:
  //   controlBasePage   - main fork-save/scratch page
  //   channelPage       - main syscall channel primary page
  //   channelPage+1     - main syscall channel spill page
  //
  // Pthread slots are addressed with positive offsets from slot start:
  //   slot+0            - TLS/control page
  //   slot+1            - per-thread fork-save/scratch page
  //   slot+2            - syscall channel primary page
  //   slot+3            - syscall channel spill page
  const channelPage = controlBasePage + PROCESS_MEMORY_MAIN_CHANNEL_PRIMARY_PAGE;
  const channelOffset = channelPage * WASM_PAGE_SIZE;
  const firstThreadSlotPage = channelPage + CHANNEL_PAGES;
  const firstThreadBasePage =
    firstThreadSlotPage + PROCESS_MEMORY_THREAD_SLOT_CHANNEL_PRIMARY_PAGE;
  const threadArenaEndPage =
    firstThreadSlotPage + (
      options.preallocateThreadSlots ? threadSlotCount * PROCESS_MEMORY_PAGES_PER_THREAD_SLOT : 0
    );

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
    firstThreadSlotPage,
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

export interface ProcessMemoryAllocationRequest {
  ptrWidth: 4 | 8;
  initialPages: number;
  maximumPages: number;
}

export interface ProcessMemoryAllocatorOptions {
  /** Maximum number of simultaneously live process address spaces. */
  maxMemories: number;
  /**
   * Allocation budget for live process address spaces.
   * Guest memory.grow can cross it while a process runs; the allocator observes
   * that growth before the next allocation and fails the new allocation.
   */
  maxTotalBytes: number;
  /**
   * Short-lived admission bound for address spaces whose host owners were just
   * detached. This is deliberately separate from the live-memory budget: a
   * theoretical multi-GiB live growth ceiling must not also authorize a
   * multi-GiB retirement burst.
   */
  maxRetirementBacklogMemories?: number;
  /** Byte peer of `maxRetirementBacklogMemories`. */
  maxRetirementBacklogBytes?: number;
  /**
   * Minimum time that a detached allocation contributes to temporary
   * retirement backpressure. Capacity returns after this bounded interval
   * whether or not FinalizationRegistry has produced telemetry.
   */
  retirementBackpressureMs?: number;
  /**
   * Bound for numeric-only finalization telemetry. Old records are evicted
   * rather than allowing diagnostic bookkeeping to grow with process churn.
   */
  maxRetirementTelemetryRecords?: number;
  /**
   * Optional diagnostic hook invoked with weak retirement evidence.
   *
   * WHY: JavaScript exposes no portable way to request collection or discard
   * Shared WebAssembly.Memory pages. The hook may create bounded allocation
   * pressure, but correctness and eventual admission must not depend on it.
   */
  retirementPressureHook?: (
    retirement: ProcessMemoryRetirementNotice,
  ) => void;
}

export interface ProcessMemoryLease {
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  readonly maximumPages: number;
  /**
   * Retire this exact backing after every Worker and channel that could touch
   * it has crossed its explicit quiescence fence. A lease is single-owner
   * authority and may be consumed exactly once.
   */
  release(): void;
  /**
   * Drop this host's alias after force-terminating an owner that cannot
   * acknowledge quiescence.
   *
   * Fresh-only allocation makes this safe: the terminated worker may keep its
   * own Memory alive briefly, but the address space is never handed to another
   * process. The allocator therefore applies bounded retirement backpressure
   * without deliberately retaining the Memory.
   */
  releaseAfterForcedTermination(): void;
}

export interface ProcessMemoryRetirementNotice {
  readonly retirementId: number;
  readonly retirementMode: "quiescent" | "forced";
  readonly ptrWidth: 4 | 8;
  readonly maximumPages: number;
  readonly byteLength: number;
  readonly trackedTargets: number;
}

export interface ProcessMemoryRetirementStats {
  readonly observedRetirements: number;
  readonly observedFinalizations: number;
  readonly liveMemories: number;
  readonly liveBytes: number;
  readonly pendingRetirements: number;
  readonly pendingRetiredBytes: number;
  readonly retirementBacklogMemories: number;
  readonly retirementBacklogBytes: number;
  readonly chargedMemories: number;
  readonly chargedBytes: number;
}

const PROCESS_MEMORY_RETIREMENT_BACKLOG_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Derive a small retirement burst bound independently from the theoretical
 * live address-space budget.
 *
 * Two retiring generations per configured Worker slot cover ordinary exec
 * and replacement overlap. The fixed caps prevent a high process maximum or a
 * multi-GiB guest growth ceiling from silently authorizing an equally large
 * stale-generation backlog.
 */
export function deriveProcessMemoryRetirementLimits(
  maxWorkers: number,
  maxTotalBytes: number,
): {
  maxRetirementBacklogMemories: number;
  maxRetirementBacklogBytes: number;
} {
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) {
    throw new Error(`invalid process worker limit: ${maxWorkers}`);
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error(`invalid process memory byte budget: ${maxTotalBytes}`);
  }
  return {
    maxRetirementBacklogMemories: Math.max(
      4,
      Math.min(32, maxWorkers * 2),
    ),
    maxRetirementBacklogBytes: Math.min(
      maxTotalBytes,
      PROCESS_MEMORY_RETIREMENT_BACKLOG_MAX_BYTES,
    ),
  };
}

/**
 * Build a coalesced collection-pressure hook for the persistent kernel realm.
 *
 * The ArrayBuffer is intentionally untouched: allocating it tells the engine
 * about bounded external-memory pressure without faulting 32 MiB of physical
 * pages into RSS. Exactly one buffer remains rooted and is replaced only after
 * a later macrotask, so a burst of exits does not allocate once per process.
 */
export function createProcessMemoryRetirementPressureHook(
  pressureBytes = 32 * 1024 * 1024,
): (retirement: ProcessMemoryRetirementNotice) => void {
  if (!Number.isSafeInteger(pressureBytes) || pressureBytes < 0) {
    throw new Error(
      `invalid process memory retirement pressure: ${pressureBytes}`,
    );
  }
  let pending = false;
  let pressure: ArrayBuffer | undefined;
  return (_retirement) => {
    if (pressureBytes === 0 || pending) return;
    pending = true;
    setTimeout(() => {
      pressure = new ArrayBuffer(pressureBytes);
      // Keep the newest bounded allocation rooted until the next retirement.
      void pressure;
      pending = false;
    }, 0);
  };
}

export class ProcessMemoryCapacityError extends Error {
  readonly errno = 12; // ENOMEM
  readonly requestedBytes: number;
  readonly chargedBytes: number;
  readonly maxTotalBytes: number;

  constructor(
    message: string,
    requestedBytes: number,
    chargedBytes: number,
    maxTotalBytes: number,
  ) {
    super(message);
    this.name = "ProcessMemoryCapacityError";
    this.requestedBytes = requestedBytes;
    this.chargedBytes = chargedBytes;
    this.maxTotalBytes = maxTotalBytes;
  }
}

export class ProcessMemoryRetirementBacklogError extends Error {
  readonly errno = 11; // EAGAIN
  readonly requestedBytes: number;
  readonly pendingRetiredMemories: number;
  readonly pendingRetiredBytes: number;
  readonly maxRetirementBacklogMemories: number;
  readonly maxRetirementBacklogBytes: number;

  constructor(
    message: string,
    requestedBytes: number,
    pendingRetiredMemories: number,
    pendingRetiredBytes: number,
    maxRetirementBacklogMemories: number,
    maxRetirementBacklogBytes: number,
  ) {
    super(message);
    this.name = "ProcessMemoryRetirementBacklogError";
    this.requestedBytes = requestedBytes;
    this.pendingRetiredMemories = pendingRetiredMemories;
    this.pendingRetiredBytes = pendingRetiredBytes;
    this.maxRetirementBacklogMemories = maxRetirementBacklogMemories;
    this.maxRetirementBacklogBytes = maxRetirementBacklogBytes;
  }
}

type ProcessMemoryRecord = {
  allocationId: number;
  memory: WebAssembly.Memory | undefined;
  ptrWidth: 4 | 8;
  maximumPages: number;
  accountedBytes: number;
  state: "leased" | "retiring";
  retirementMode?: "quiescent" | "forced";
  retirementBackpressureActive: boolean;
  retirementBackpressureTimer?: ReturnType<typeof setTimeout>;
  finalizationObserved: boolean;
  telemetryQueued: boolean;
  pendingTargets: Map<number, object>;
};

class OwnedProcessMemoryLease implements ProcessMemoryLease {
  private ownedMemory: WebAssembly.Memory | undefined;
  private consumeOwnedRecord:
    | ((retirementMode: "quiescent" | "forced") => void)
    | undefined;

  constructor(
    memory: WebAssembly.Memory,
    readonly ptrWidth: 4 | 8,
    readonly maximumPages: number,
    consumeOwnedRecord: (retirementMode: "quiescent" | "forced") => void,
  ) {
    this.ownedMemory = memory;
    this.consumeOwnedRecord = consumeOwnedRecord;
  }

  get memory(): WebAssembly.Memory {
    if (!this.ownedMemory) {
      throw new Error("Process memory lease was already consumed");
    }
    return this.ownedMemory;
  }

  release(): void {
    this.consume("quiescent");
  }

  releaseAfterForcedTermination(): void {
    this.consume("forced");
  }

  private consume(retirementMode: "quiescent" | "forced"): void {
    const consumeOwnedRecord = this.consumeOwnedRecord;
    if (!consumeOwnedRecord || !this.ownedMemory) {
      throw new Error("Process memory lease was already consumed");
    }
    consumeOwnedRecord(retirementMode);
    // WHY: a consumed lease may itself outlive the process record. Sever both
    // strong paths so merely retaining the lease cannot retain the Memory.
    this.ownedMemory = undefined;
    this.consumeOwnedRecord = undefined;
  }
}

/**
 * Session-owned allocator for fresh process Shared WebAssembly.Memory objects.
 *
 * Every allocation is a new POSIX address space. Safe retirement drops the
 * allocator's strong reference only after the host proves that the exact
 * Worker generation and all channel listeners are quiescent. Ambiguous
 * forced termination uses a separately tracked retirement mode instead.
 *
 * A bounded FinalizationRegistry ledger records observed Memory/buffer/view
 * wrappers without retaining them. It is telemetry, not ownership authority:
 * callbacks may be arbitrarily late or absent, so capacity never depends on
 * finalization. A short independently bounded retirement window instead slows
 * bursts long enough for ordinary engine reclamation without making a delayed
 * callback a permanent process-creation failure.
 */
export class ProcessMemoryAllocator {
  private readonly records = new Map<number, ProcessMemoryRecord>();
  private readonly recordsByMemory =
    new WeakMap<WebAssembly.Memory, ProcessMemoryRecord>();
  private readonly observedTargets = new WeakMap<object, number>();
  private readonly retirementRegistry:
    | FinalizationRegistry<{
        allocationId: number;
        targetId: number;
      }>
    | undefined;
  private readonly maxRetirementBacklogMemories: number;
  private readonly maxRetirementBacklogBytes: number;
  private readonly retirementBackpressureMs: number;
  private readonly maxRetirementTelemetryRecords: number;
  private readonly retirementTelemetryOrder: number[] = [];
  private liveMemories = 0;
  private liveBytes = 0;
  private retirementBacklogMemories = 0;
  private retirementBacklogBytes = 0;
  private retirementTelemetryRecords = 0;
  private readonly retirementBacklogWaiters = new Set<() => void>();
  private nextAllocationId = 1;
  private nextTargetId = 1;
  private observedRetirements = 0;
  private observedFinalizations = 0;

  constructor(private readonly options: ProcessMemoryAllocatorOptions) {
    if (
      !Number.isSafeInteger(options.maxMemories)
      || options.maxMemories <= 0
    ) {
      throw new Error(
        `invalid process memory count budget: ${options.maxMemories}`,
      );
    }
    if (
      !Number.isSafeInteger(options.maxTotalBytes)
      || options.maxTotalBytes <= 0
    ) {
      throw new Error(
        `invalid process memory byte budget: ${options.maxTotalBytes}`,
      );
    }
    this.maxRetirementBacklogMemories =
      options.maxRetirementBacklogMemories
      ?? Math.max(1, Math.min(options.maxMemories, 8));
    this.maxRetirementBacklogBytes =
      options.maxRetirementBacklogBytes
      ?? Math.min(
        options.maxTotalBytes,
        PROCESS_MEMORY_RETIREMENT_BACKLOG_MAX_BYTES,
      );
    this.retirementBackpressureMs = options.retirementBackpressureMs ?? 50;
    this.maxRetirementTelemetryRecords =
      options.maxRetirementTelemetryRecords ?? 256;
    if (
      !Number.isSafeInteger(this.maxRetirementBacklogMemories)
      || this.maxRetirementBacklogMemories <= 0
    ) {
      throw new Error(
        `invalid process memory retirement count bound: ${this.maxRetirementBacklogMemories}`,
      );
    }
    if (
      !Number.isSafeInteger(this.maxRetirementBacklogBytes)
      || this.maxRetirementBacklogBytes <= 0
    ) {
      throw new Error(
        `invalid process memory retirement byte bound: ${this.maxRetirementBacklogBytes}`,
      );
    }
    if (
      !Number.isSafeInteger(this.retirementBackpressureMs)
      || this.retirementBackpressureMs < 0
    ) {
      throw new Error(
        `invalid process memory retirement backpressure interval: ${this.retirementBackpressureMs}`,
      );
    }
    if (
      !Number.isSafeInteger(this.maxRetirementTelemetryRecords)
      || this.maxRetirementTelemetryRecords < 0
    ) {
      throw new Error(
        `invalid process memory retirement telemetry bound: ${this.maxRetirementTelemetryRecords}`,
      );
    }
    this.retirementRegistry = typeof FinalizationRegistry === "function"
      ? new FinalizationRegistry<{
          allocationId: number;
          targetId: number;
        }>((target) => {
          const record = this.records.get(target.allocationId);
          if (!record?.pendingTargets.delete(target.targetId)) return;
          this.finishRetirementIfCollected(record);
        })
      : undefined;
  }

  acquire(request: ProcessMemoryAllocationRequest): ProcessMemoryLease {
    return this.acquireInternal(request, false);
  }

  /**
   * Wait through the allocator's short retirement window before allocating.
   *
   * Healthy sequential churn should not surface the internal retirement
   * throttle as a guest errno. The bounded timeout preserves EAGAIN as a
   * truthful fallback if admission cannot recover.
   */
  async acquireWhenAvailable(
    request: ProcessMemoryAllocationRequest,
    timeoutMs = Math.max(250, this.retirementBackpressureMs * 4),
  ): Promise<ProcessMemoryLease> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return this.acquire(request);
      } catch (error) {
        if (!(error instanceof ProcessMemoryRetirementBacklogError)) {
          throw error;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw error;
        await this.waitForRetirementBacklogCapacity(
          error.requestedBytes,
          remainingMs,
        );
      }
    }
  }

  /**
   * Acquire the child's exact syscall-time fork snapshot synchronously.
   *
   * WHY: awaiting retirement admission before copying would let a sibling
   * thread mutate the parent address space after fork committed. This narrow
   * bypass still obeys the hard live count/byte budgets; callers must await
   * `waitForRetirementBacklogCapacity()` before launching the child Worker.
   */
  acquireForForkSnapshot(
    request: ProcessMemoryAllocationRequest,
  ): ProcessMemoryLease {
    return this.acquireInternal(request, true);
  }

  async waitForRetirementBacklogCapacity(
    requestedBytes: number,
    timeoutMs = Math.max(250, this.retirementBackpressureMs * 4),
  ): Promise<void> {
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      throw new Error(
        `invalid process memory retirement admission size: ${requestedBytes}`,
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error(
        `invalid process memory retirement admission timeout: ${timeoutMs}`,
      );
    }
    if (!this.retirementBacklogSaturated()) return;

    let wake!: () => void;
    const awakened = new Promise<void>((resolve) => {
      wake = resolve;
      this.retirementBacklogWaiters.add(resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        awakened,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      this.retirementBacklogWaiters.delete(wake);
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.retirementBacklogSaturated()) {
      throw this.createRetirementBacklogError(requestedBytes);
    }
  }

  private acquireInternal(
    request: ProcessMemoryAllocationRequest,
    bypassRetirementBacklog: boolean,
  ): ProcessMemoryLease {
    this.validateRequest(request);
    this.refreshOwnedBytes();
    const requestedBytes = request.initialPages * WASM_PAGE_SIZE;
    if (requestedBytes > this.options.maxTotalBytes) {
      throw new ProcessMemoryCapacityError(
        `Process memory request exceeds byte budget ${this.options.maxTotalBytes}`,
        requestedBytes,
        this.liveBytes,
        this.options.maxTotalBytes,
      );
    }
    this.requireAllocationCapacity(
      requestedBytes,
      bypassRetirementBacklog,
    );
    const memory = this.createMemory(request);
    const record: ProcessMemoryRecord = {
      allocationId: this.nextAllocationId++,
      memory,
      ptrWidth: request.ptrWidth,
      maximumPages: request.maximumPages,
      accountedBytes: memory.buffer.byteLength,
      state: "leased",
      retirementBackpressureActive: false,
      finalizationObserved: false,
      telemetryQueued: false,
      pendingTargets: new Map(),
    };
    this.records.set(record.allocationId, record);
    this.recordsByMemory.set(memory, record);
    this.liveMemories += 1;
    this.liveBytes = this.safeAdd(this.liveBytes, record.accountedBytes);
    this.observeTargetRecord(record, memory);
    this.observeTargetRecord(record, memory.buffer);
    return new OwnedProcessMemoryLease(
      memory,
      record.ptrWidth,
      record.maximumPages,
      (retirementMode) => this.releaseRecord(record, retirementMode),
    );
  }

  /**
   * Record a persistent wrapper or buffer generation that can keep one process
   * address space reachable from the kernel Worker realm.
   */
  observeTarget(memory: WebAssembly.Memory, target: object): void {
    const record = this.recordsByMemory.get(memory);
    if (!record || record.state !== "leased") {
      throw new Error("Cannot observe a target for unknown process memory");
    }
    this.observeTargetRecord(record, target);
  }

  clear(): void {
    for (const record of this.records.values()) {
      if (record.state === "leased") {
        throw new Error(
          "Cannot clear process memory allocator with leased memory",
        );
      }
      if (record.retirementBackpressureTimer !== undefined) {
        clearTimeout(record.retirementBackpressureTimer);
      }
      for (const token of record.pendingTargets.values()) {
        this.retirementRegistry?.unregister(token);
      }
    }
    this.records.clear();
    this.retirementTelemetryOrder.length = 0;
    this.liveMemories = 0;
    this.liveBytes = 0;
    this.retirementBacklogMemories = 0;
    this.retirementBacklogBytes = 0;
    this.retirementTelemetryRecords = 0;
    this.notifyRetirementBacklogWaiters();
  }

  getRetirementStats(): ProcessMemoryRetirementStats {
    let pendingRetirements = 0;
    let pendingRetiredBytes = 0;
    for (const record of this.records.values()) {
      if (record.state !== "retiring") continue;
      pendingRetirements += 1;
      pendingRetiredBytes = this.safeAdd(
        pendingRetiredBytes,
        record.accountedBytes,
      );
    }
    return {
      observedRetirements: this.observedRetirements,
      observedFinalizations: this.observedFinalizations,
      liveMemories: this.liveMemories,
      liveBytes: this.liveBytes,
      pendingRetirements,
      pendingRetiredBytes,
      retirementBacklogMemories: this.retirementBacklogMemories,
      retirementBacklogBytes: this.retirementBacklogBytes,
      chargedMemories:
        this.liveMemories + this.retirementBacklogMemories,
      chargedBytes: this.safeAdd(
        this.liveBytes,
        this.retirementBacklogBytes,
      ),
    };
  }

  private releaseRecord(
    record: ProcessMemoryRecord,
    retirementMode: "quiescent" | "forced",
  ): void {
    if (
      this.records.get(record.allocationId) !== record
      || record.state !== "leased"
    ) {
      throw new Error("Process memory record is not an active lease");
    }

    const memory = record.memory;
    if (!memory) {
      throw new Error("Process memory record lost its active Memory");
    }
    this.observeTargetRecord(record, memory.buffer);
    const actualBytes = memory.buffer.byteLength;
    if (actualBytes < record.accountedBytes) {
      throw new Error("WebAssembly.Memory unexpectedly shrank");
    }
    this.liveBytes = this.safeAdd(
      this.liveBytes,
      actualBytes - record.accountedBytes,
    );
    record.accountedBytes = actualBytes;
    this.liveBytes = Math.max(0, this.liveBytes - actualBytes);
    this.liveMemories = Math.max(0, this.liveMemories - 1);
    this.recordsByMemory.delete(memory);
    record.state = "retiring";
    record.retirementMode = retirementMode;
    record.retirementBackpressureActive = true;
    record.memory = undefined;
    this.retirementBacklogMemories += 1;
    this.retirementBacklogBytes = this.safeAdd(
      this.retirementBacklogBytes,
      actualBytes,
    );
    this.observedRetirements += 1;
    const notice: ProcessMemoryRetirementNotice = Object.freeze({
      retirementId: record.allocationId,
      retirementMode,
      ptrWidth: record.ptrWidth,
      maximumPages: record.maximumPages,
      byteLength: record.accountedBytes,
      trackedTargets: record.pendingTargets.size,
    });
    // WHY: same-turn fork/exec churn can allocate new native Shared Wasm
    // backings faster than engines retire detached generations. This short,
    // separately bounded window provides backpressure without making optional
    // FinalizationRegistry delivery a permanent admission prerequisite.
    const allocationId = record.allocationId;
    record.retirementBackpressureTimer = setTimeout(() => {
      this.releaseRetirementBackpressure(allocationId);
    }, this.retirementBackpressureMs);
    const hook = this.options.retirementPressureHook;
    if (hook) {
      setTimeout(() => {
        try {
          hook(notice);
        } catch {
          // Collection pressure is diagnostic/backstop only. A broken hook
          // must not change ownership or capacity state.
        }
      }, 0);
    }
    this.finishRetirementIfCollected(record);
  }

  private requireAllocationCapacity(
    requestedBytes: number,
    bypassRetirementBacklog = false,
  ): void {
    if (!bypassRetirementBacklog && this.retirementBacklogSaturated()) {
      throw this.createRetirementBacklogError(requestedBytes);
    }
    if (this.liveMemories >= this.options.maxMemories) {
      throw new ProcessMemoryCapacityError(
        `Live process memory object budget ${this.options.maxMemories} is exhausted`,
        requestedBytes,
        this.liveBytes,
        this.options.maxTotalBytes,
      );
    }
    if (this.liveBytes + requestedBytes > this.options.maxTotalBytes) {
      throw new ProcessMemoryCapacityError(
        `Live process memory byte budget ${this.options.maxTotalBytes} is exhausted`,
        requestedBytes,
        this.liveBytes,
        this.options.maxTotalBytes,
      );
    }
  }

  private retirementBacklogSaturated(): boolean {
    return (
      this.retirementBacklogMemories >=
        this.maxRetirementBacklogMemories
      || this.retirementBacklogBytes >= this.maxRetirementBacklogBytes
    );
  }

  private createRetirementBacklogError(
    requestedBytes: number,
  ): ProcessMemoryRetirementBacklogError {
    return new ProcessMemoryRetirementBacklogError(
      "Process memory retirement backlog is temporarily saturated",
      requestedBytes,
      this.retirementBacklogMemories,
      this.retirementBacklogBytes,
      this.maxRetirementBacklogMemories,
      this.maxRetirementBacklogBytes,
    );
  }

  private validateRequest(request: ProcessMemoryAllocationRequest): void {
    if (request.ptrWidth !== 4 && request.ptrWidth !== 8) {
      throw new Error(`invalid process pointer width: ${request.ptrWidth}`);
    }
    if (
      !Number.isSafeInteger(request.initialPages)
      || request.initialPages <= 0
      || !Number.isSafeInteger(request.maximumPages)
      || request.maximumPages < request.initialPages
    ) {
      throw new Error(
        `invalid process memory pages: ${request.initialPages}/${request.maximumPages}`,
      );
    }
    const requestedBytes = request.initialPages * WASM_PAGE_SIZE;
    const maximumBytes = request.maximumPages * WASM_PAGE_SIZE;
    if (
      !Number.isSafeInteger(requestedBytes)
      || !Number.isSafeInteger(maximumBytes)
    ) {
      throw new Error(`process memory byte length is not a safe integer`);
    }
  }

  private createMemory(
    request: ProcessMemoryAllocationRequest,
  ): WebAssembly.Memory {
    if (request.ptrWidth === 8) {
      return new WebAssembly.Memory({
        initial: BigInt(request.initialPages) as any,
        maximum: BigInt(request.maximumPages) as any,
        shared: true,
        address: "i64",
      } as any);
    }
    return new WebAssembly.Memory({
      initial: request.initialPages,
      maximum: request.maximumPages,
      shared: true,
    });
  }

  private refreshOwnedBytes(): void {
    let liveBytes = 0;
    let liveMemories = 0;
    for (const record of this.records.values()) {
      if (record.state !== "leased") continue;
      const memory = record.memory;
      if (!memory) {
        throw new Error("Live process memory record lost its Memory");
      }
      this.observeTargetRecord(record, memory.buffer);
      const actualBytes = memory.buffer.byteLength;
      if (actualBytes < record.accountedBytes) {
        throw new Error("WebAssembly.Memory unexpectedly shrank");
      }
      record.accountedBytes = actualBytes;
      liveMemories += 1;
      liveBytes = this.safeAdd(liveBytes, actualBytes);
    }
    this.liveMemories = liveMemories;
    this.liveBytes = liveBytes;
  }

  private observeTargetRecord(
    record: ProcessMemoryRecord,
    target: object,
  ): void {
    if (!this.retirementRegistry) return;
    if (this.observedTargets.has(target)) return;
    const targetId = this.nextTargetId++;
    const unregisterToken = {};
    this.observedTargets.set(target, targetId);
    record.pendingTargets.set(targetId, unregisterToken);
    this.retirementRegistry.register(
      target,
      { allocationId: record.allocationId, targetId },
      unregisterToken,
    );
  }

  private finishRetirementIfCollected(record: ProcessMemoryRecord): void {
    if (
      !this.retirementRegistry
      || record.state !== "retiring"
      || record.finalizationObserved
      || record.pendingTargets.size !== 0
    ) {
      return;
    }
    record.finalizationObserved = true;
    this.observedFinalizations += 1;
    if (!record.retirementBackpressureActive) {
      this.removeRetirementRecord(record);
    }
  }

  private releaseRetirementBackpressure(allocationId: number): void {
    const record = this.records.get(allocationId);
    if (
      !record
      || record.state !== "retiring"
      || !record.retirementBackpressureActive
    ) {
      return;
    }
    record.retirementBackpressureTimer = undefined;
    record.retirementBackpressureActive = false;
    this.retirementBacklogMemories = Math.max(
      0,
      this.retirementBacklogMemories - 1,
    );
    this.retirementBacklogBytes = Math.max(
      0,
      this.retirementBacklogBytes - record.accountedBytes,
    );
    if (!this.retirementBacklogSaturated()) {
      this.notifyRetirementBacklogWaiters();
    }
    if (!this.retirementRegistry || record.finalizationObserved) {
      this.removeRetirementRecord(record);
      return;
    }
    record.telemetryQueued = true;
    this.retirementTelemetryRecords += 1;
    this.retirementTelemetryOrder.push(record.allocationId);
    this.trimRetirementTelemetry();
  }

  private trimRetirementTelemetry(): void {
    while (
      this.retirementTelemetryRecords >
      this.maxRetirementTelemetryRecords
    ) {
      const allocationId = this.retirementTelemetryOrder.shift();
      if (allocationId === undefined) return;
      const record = this.records.get(allocationId);
      if (!record?.telemetryQueued) continue;
      this.removeRetirementRecord(record);
    }
  }

  private removeRetirementRecord(record: ProcessMemoryRecord): void {
    if (
      record.state !== "retiring"
      || record.retirementBackpressureActive
      || !this.records.delete(record.allocationId)
    ) {
      return;
    }
    if (record.telemetryQueued) {
      record.telemetryQueued = false;
      this.retirementTelemetryRecords = Math.max(
        0,
        this.retirementTelemetryRecords - 1,
      );
    }
    for (const token of record.pendingTargets.values()) {
      this.retirementRegistry?.unregister(token);
    }
    record.pendingTargets.clear();
  }

  private notifyRetirementBacklogWaiters(): void {
    for (const wake of this.retirementBacklogWaiters) wake();
    this.retirementBacklogWaiters.clear();
  }

  private safeAdd(left: number, right: number): number {
    const result = left + right;
    return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
  }
}

const PROCESS_MEMORY_COPY_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Acquire and synchronously populate the exact address-space generation for a
 * committed fork.
 *
 * WHY: host fork launch later awaits module compilation and Worker teardown.
 * A sibling exec may retire the parent's lease during either await. Copying
 * into this independently owned fresh lease before the first yield prevents
 * that race from changing the child's fork snapshot.
 */
export function acquireForkMemoryClone(
  allocator: ProcessMemoryAllocator,
  parentMemory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  maximumPages: number,
): ProcessMemoryLease {
  const parentBytes = parentMemory.buffer.byteLength;
  if (parentBytes % WASM_PAGE_SIZE !== 0) {
    throw new Error(`fork parent memory is not page-aligned: ${parentBytes}`);
  }
  const lease = allocator.acquireForForkSnapshot({
    ptrWidth,
    initialPages: parentBytes / WASM_PAGE_SIZE,
    maximumPages,
  });
  try {
    copyArrayBufferInChunks(lease.memory.buffer, parentMemory.buffer);
    return lease;
  } catch (error) {
    // This clone has not been registered or exposed to a Worker, so it can be
    // safely retired immediately.
    lease.release();
    throw error;
  }
}

/**
 * Copy equal-length process address spaces without relying on one potentially
 * multi-gigabyte TypedArray view.
 */
export function copyArrayBufferInChunks(
  destination: ArrayBufferLike,
  source: ArrayBufferLike,
  chunkBytes = PROCESS_MEMORY_COPY_CHUNK_BYTES,
): void {
  if (destination.byteLength !== source.byteLength) {
    throw new Error(
      `process memory copy length mismatch: ${source.byteLength}/${destination.byteLength}`,
    );
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`invalid process memory copy chunk length: ${chunkBytes}`);
  }
  for (let offset = 0; offset < source.byteLength; offset += chunkBytes) {
    const length = Math.min(chunkBytes, source.byteLength - offset);
    new Uint8Array(destination, offset, length).set(
      new Uint8Array(source, offset, length),
    );
  }
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
