import { WASM_PAGE_SIZE } from "./constants";

export const LINKED_FRAME_FORMAT_SECTION = "kandelo.wpk_fork.linked_frames";
export const LINKED_FRAME_FORMAT_VERSION = 1;
export const LINKED_FRAME_RECORD_ALIGNMENT = 8;

const DESCRIPTOR_SIZE = 24;
const DESCRIPTOR_MAGIC = 0x46434c4b; // "KLCF", little-endian
const DESCRIPTOR_FLAG_TRANSACTIONAL_NODES = 1 << 0;
const DESCRIPTOR_FLAG_ABORT_UNWINDING = 1 << 1;
const DESCRIPTOR_REQUIRED_FLAGS =
  DESCRIPTOR_FLAG_TRANSACTIONAL_NODES | DESCRIPTOR_FLAG_ABORT_UNWINDING;
const CHUNK_MAGIC = 0x4843464b; // "KFCH", little-endian
const NODE_MAGIC = 0x4e43464b; // "KFCN", little-endian
const NODE_RESERVED = 1;
const NODE_COMMITTED = 2;
const NODE_CONSUMED = 3;

export interface LinkedFrameFormatDescriptor {
  version: number;
  ptrWidth: 4 | 8;
  alignment: number;
  flags: number;
  chunkHeaderSize: number;
  nodeHeaderSize: number;
  fixedPrefixSize: number;
}

export type ContinuationAllocate = (size: number) => number;
export type ContinuationDeallocate = (addr: number, size: number) => void;
export type ForkContinuationGuestAddress = number | bigint;

/**
 * Invoke an instrumented continuation begin export with the module's exact
 * pointer-width calling convention.
 *
 * WHY: WebAssembly i64 parameters require JavaScript BigInt even when the
 * address itself fits in a Number. Keeping this conversion at the shared
 * continuation boundary prevents main, pthread, and side-module paths from
 * silently drifting apart.
 */
export function invokeForkContinuationBegin(
  exported: unknown,
  address: number,
  ptrWidth: 4 | 8,
  context: string,
): void {
  if (typeof exported !== "function") {
    throw new TypeError(`${context}: continuation begin export is not callable`);
  }
  if (!Number.isSafeInteger(address) || address <= 0) {
    throw new RangeError(`${context}: invalid continuation address ${address}`);
  }
  const guestAddress: ForkContinuationGuestAddress = ptrWidth === 8
    ? BigInt(address)
    : address;
  (exported as (value: ForkContinuationGuestAddress) => void)(guestAddress);
}

export class ContinuationAllocationError extends Error {
  constructor(
    readonly errno: number,
    readonly requestedSize: number,
    message: string,
  ) {
    super(message);
    this.name = "ContinuationAllocationError";
  }
}

interface AbortFailure {
  errno: number;
  requestedFrame?: number;
  diagnostic: string;
}

export function writeForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
  moduleBufferAddr: number,
): void {
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(anchorAddr, BigInt(moduleBufferAddr), true);
  else view.setUint32(anchorAddr, moduleBufferAddr, true);
}

export function readForkContinuationAnchor(
  memory: WebAssembly.Memory,
  anchorAddr: number,
  ptrWidth: 4 | 8,
): number {
  const view = new DataView(memory.buffer);
  const value = ptrWidth === 8
    ? Number(view.getBigUint64(anchorAddr, true))
    : view.getUint32(anchorAddr, true);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid fork continuation anchor ${String(value)}`);
  }
  return value;
}

function expectedChunkHeaderSize(ptrWidth: 4 | 8): number {
  return 8 + 6 * ptrWidth;
}

function expectedNodeHeaderSize(ptrWidth: 4 | 8): number {
  return Math.ceil((8 + 3 * ptrWidth) / LINKED_FRAME_RECORD_ALIGNMENT)
    * LINKED_FRAME_RECORD_ALIGNMENT;
}

function alignUp(value: number, alignment: number): number {
  const result = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`linked continuation alignment overflow: ${value}`);
  }
  return result;
}

function checkedEnd(addr: number, size: number): number {
  const end = addr + size;
  if (
    !Number.isSafeInteger(addr)
    || !Number.isSafeInteger(size)
    || addr < 0
    || size < 0
    || !Number.isSafeInteger(end)
  ) {
    throw new Error(`invalid linked continuation range addr=${addr} size=${size}`);
  }
  return end;
}

export function readLinkedFrameFormat(
  module: WebAssembly.Module,
): LinkedFrameFormatDescriptor {
  const sections = WebAssembly.Module.customSections(module, LINKED_FRAME_FORMAT_SECTION);
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${LINKED_FRAME_FORMAT_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]);
  if (bytes.byteLength !== DESCRIPTOR_SIZE) {
    throw new Error(
      `linked continuation metadata has ${bytes.byteLength} bytes, expected ${DESCRIPTOR_SIZE}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== DESCRIPTOR_MAGIC) {
    throw new Error("linked continuation metadata has invalid magic");
  }
  const version = view.getUint16(4, true);
  if (version !== LINKED_FRAME_FORMAT_VERSION) {
    throw new Error(`unsupported linked continuation metadata version ${version}`);
  }
  if (view.getUint16(6, true) !== DESCRIPTOR_SIZE) {
    throw new Error("linked continuation metadata has an invalid declared size");
  }
  const ptrWidth = view.getUint8(8);
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new Error(`unsupported linked continuation pointer width ${ptrWidth}`);
  }
  const alignment = view.getUint8(9);
  if (alignment !== LINKED_FRAME_RECORD_ALIGNMENT) {
    throw new Error(`unsupported linked continuation alignment ${alignment}`);
  }
  const flags = view.getUint16(10, true);
  if (flags !== DESCRIPTOR_REQUIRED_FLAGS) {
    throw new Error(`unsupported linked continuation flags 0x${flags.toString(16)}`);
  }
  const chunkHeaderSize = view.getUint32(12, true);
  const nodeHeaderSize = view.getUint32(16, true);
  const fixedPrefixSize = view.getUint32(20, true);
  if (
    chunkHeaderSize !== expectedChunkHeaderSize(ptrWidth)
    || nodeHeaderSize !== expectedNodeHeaderSize(ptrWidth)
  ) {
    throw new Error("linked continuation metadata header sizes do not match pointer width");
  }
  return {
    version,
    ptrWidth,
    alignment,
    flags,
    chunkHeaderSize,
    nodeHeaderSize,
    fixedPrefixSize,
  };
}

interface PendingNode {
  chunk: number;
  node: number;
  payload: number;
  nextUsed: number;
}

/**
 * Host-side owner and validator for one module instance's linked fork frames.
 * Allocations are ordinary anonymous process mappings, so kernel brk/mmap
 * ownership, fork inheritance, and memory growth remain authoritative.
 */
export class LinkedForkContinuation {
  private root = 0;
  private activeChunk = 0;
  private replayNode = 0;
  private pending: PendingNode | null = null;
  private chunks: Array<{ addr: number; size: number }> = [];
  private committedFrames = 0;
  private committedBytes = 0;
  private abortFailure: AbortFailure | null = null;

  constructor(
    private readonly memory: WebAssembly.Memory,
    readonly format: LinkedFrameFormatDescriptor,
    private readonly allocate: ContinuationAllocate,
    private readonly deallocate: ContinuationDeallocate,
    private readonly label: string,
  ) {}

  beginUnwind(): number | bigint {
    if (this.root !== 0) {
      throw new Error(`${this.label}: linked continuation already active`);
    }
    const initialUsed = alignUp(
      this.format.chunkHeaderSize + this.format.fixedPrefixSize,
      this.format.alignment,
    );
    const capacity = alignUp(Math.max(initialUsed, WASM_PAGE_SIZE), WASM_PAGE_SIZE);
    this.committedFrames = 0;
    this.committedBytes = 0;
    this.abortFailure = null;
    let root: number;
    try {
      root = this.allocateChunk(capacity, 0, 0);
    } catch (error) {
      if (error instanceof ContinuationAllocationError) {
        this.releaseAfterFailure(error);
      }
      this.abortAndRelease(undefined, error);
    }
    this.root = root;
    this.activeChunk = root;
    this.writePtr(root + 8 + 4 * this.format.ptrWidth, initialUsed);
    return this.asGuestPtr(root + this.format.chunkHeaderSize);
  }

  attachForReplay(moduleBuffer: number | bigint): void {
    if (this.root !== 0) {
      throw new Error(`${this.label}: linked continuation already active`);
    }
    const moduleBufferNumber = this.fromGuestPtr(moduleBuffer);
    const root = moduleBufferNumber - this.format.chunkHeaderSize;
    this.validateChunk(root, root, 0);
    this.root = root;
    this.chunks = [];
    let chunk = root;
    let previous = 0;
    for (;;) {
      this.validateChunk(chunk, root, previous);
      const capacity = this.readPtr(chunk + 8 + 3 * this.format.ptrWidth);
      this.chunks.push({ addr: chunk, size: capacity });
      const next = this.readPtr(chunk + 8 + 2 * this.format.ptrWidth);
      if (next === 0) {
        this.activeChunk = chunk;
        break;
      }
      previous = chunk;
      chunk = next;
      if (this.chunks.length > 1_000_000) {
        throw new Error(`${this.label}: linked continuation chunk cycle`);
      }
    }
    this.replayNode = this.readPtr(root + 8 + 5 * this.format.ptrWidth);
  }

  beginReplay(): void {
    if (this.root === 0 || this.pending || this.abortFailure) {
      throw new Error(`${this.label}: cannot begin replay from incomplete continuation`);
    }
    this.replayNode = this.readPtr(this.root + 8 + 5 * this.format.ptrWidth);
  }

  reserveFrame(payloadSize: number | bigint): number | bigint {
    const size = this.fromGuestPtr(payloadSize);
    if (this.root === 0 || this.activeChunk === 0) {
      throw new Error(`${this.label}: frame reservation outside unwind`);
    }
    if (this.pending) {
      throw new Error(`${this.label}: a frame reservation is already pending`);
    }
    if (this.abortFailure) {
      throw new Error(`${this.label}: frame reservation after abort began`);
    }
    const nodeSize = alignUp(
      this.format.nodeHeaderSize + size,
      this.format.alignment,
    );
    let chunk = this.activeChunk;
    let used = this.readPtr(chunk + 8 + 4 * this.format.ptrWidth);
    let capacity = this.readPtr(chunk + 8 + 3 * this.format.ptrWidth);
    if (nodeSize > capacity - used) {
      const nextCapacity = alignUp(
        Math.max(WASM_PAGE_SIZE, this.format.chunkHeaderSize + nodeSize),
        WASM_PAGE_SIZE,
      );
      let next: number;
      try {
        next = this.allocateChunk(nextCapacity, this.root, chunk);
      } catch (error) {
        if (error instanceof ContinuationAllocationError) {
          this.beginAbortReplay(error.errno, size, error.message);
          return this.asGuestPtr(0);
        }
        this.abortAndRelease(size, error);
      }
      this.writePtr(chunk + 8 + 2 * this.format.ptrWidth, next);
      this.activeChunk = next;
      chunk = next;
      used = this.format.chunkHeaderSize;
      capacity = nextCapacity;
    }
    if (nodeSize > capacity - used) {
      throw new Error(`${this.label}: allocator returned an undersized continuation chunk`);
    }
    const node = chunk + used;
    const payload = node + this.format.nodeHeaderSize;
    const previous = this.readPtr(this.root + 8 + 5 * this.format.ptrWidth);
    const view = this.view();
    view.setUint32(node, NODE_MAGIC, true);
    view.setUint16(node + 4, LINKED_FRAME_FORMAT_VERSION, true);
    view.setUint16(node + 6, NODE_RESERVED, true);
    this.writePtr(node + 8, previous);
    this.writePtr(node + 8 + this.format.ptrWidth, size);
    this.writePtr(node + 8 + 2 * this.format.ptrWidth, nodeSize);
    this.pending = { chunk, node, payload, nextUsed: used + nodeSize };
    return this.asGuestPtr(payload);
  }

  commitFrame(payload: number | bigint): void {
    if (this.abortFailure) {
      throw new Error(`${this.label}: frame commit after abort began`);
    }
    const payloadNumber = this.fromGuestPtr(payload);
    const pending = this.pending;
    if (!pending || pending.payload !== payloadNumber) {
      throw new Error(`${this.label}: frame commit does not match the pending reservation`);
    }
    this.writePtr(pending.chunk + 8 + 4 * this.format.ptrWidth, pending.nextUsed);
    this.view().setUint16(pending.node + 6, NODE_COMMITTED, true);
    // Publishing the new tail is the final write: replay can never observe a
    // reserved or partially populated node through the committed chain.
    this.writePtr(this.root + 8 + 5 * this.format.ptrWidth, pending.node);
    const payloadSize = this.readPtr(pending.node + 8 + this.format.ptrWidth);
    this.committedFrames++;
    this.committedBytes += payloadSize;
    this.pending = null;
  }

  nextFrame(expectedSize: number | bigint): number | bigint {
    const expected = this.fromGuestPtr(expectedSize);
    const node = this.replayNode;
    if (this.root === 0 || node === 0) {
      throw new Error(`${this.label}: linked continuation replay exhausted early`);
    }
    const chunk = this.chunkContaining(node);
    const view = this.view();
    if (
      view.getUint32(node, true) !== NODE_MAGIC
      || view.getUint16(node + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(node + 6, true) !== NODE_COMMITTED
    ) {
      throw new Error(`${this.label}: invalid or uncommitted linked continuation node`);
    }
    const payloadSize = this.readPtr(node + 8 + this.format.ptrWidth);
    const nodeSize = this.readPtr(node + 8 + 2 * this.format.ptrWidth);
    if (payloadSize !== expected) {
      throw new Error(
        `${this.label}: linked continuation frame size ${payloadSize} does not match ${expected}`,
      );
    }
    if (
      nodeSize !== alignUp(this.format.nodeHeaderSize + payloadSize, this.format.alignment)
      || checkedEnd(node, nodeSize) > chunk.addr + chunk.size
    ) {
      throw new Error(`${this.label}: invalid linked continuation node bounds`);
    }
    this.replayNode = this.readPtr(node + 8);
    view.setUint16(node + 6, NODE_CONSUMED, true);
    return this.asGuestPtr(node + this.format.nodeHeaderSize);
  }

  finishUnwind(): void {
    if (this.pending) {
      throw new Error(`${this.label}: unwind ended with an uncommitted frame`);
    }
    if (this.root === 0) {
      throw new Error(`${this.label}: unwind ended without a continuation`);
    }
  }

  finishReplayAndRelease(): void {
    if (this.abortFailure) {
      throw new Error(`${this.label}: normal replay ended during abort recovery`);
    }
    if (this.replayNode !== 0) {
      throw new Error(`${this.label}: rewind ended before all linked frames were consumed`);
    }
    this.release();
  }

  beginAbortReplay(
    errno: number,
    requestedFrame?: number,
    diagnostic = `fork continuation allocation failed with errno=${errno}`,
  ): void {
    if (!Number.isInteger(errno) || errno <= 0) {
      throw new Error(`${this.label}: invalid abort errno ${errno}`);
    }
    if (this.root === 0 || this.pending) {
      throw new Error(`${this.label}: cannot abort-replay an incomplete continuation`);
    }
    if (this.abortFailure && this.abortFailure.errno !== errno) {
      throw new Error(`${this.label}: conflicting continuation abort failures`);
    }
    this.abortFailure ??= { errno, requestedFrame, diagnostic };
    this.replayNode = this.readPtr(this.root + 8 + 5 * this.format.ptrWidth);
  }

  abortErrno(): number {
    if (!this.abortFailure) {
      throw new Error(`${this.label}: no continuation abort is active`);
    }
    return this.abortFailure.errno;
  }

  finishAbortReplayAndRelease(): void {
    if (!this.abortFailure) {
      throw new Error(`${this.label}: abort replay ended without an allocation failure`);
    }
    if (this.replayNode !== 0) {
      throw new Error(`${this.label}: abort replay ended before all linked frames were consumed`);
    }
    this.release();
  }

  cancelUnwindAndRelease(): void {
    if (this.pending) {
      throw new Error(`${this.label}: cannot cancel an unwind with a pending frame`);
    }
    if (this.root === 0) {
      throw new Error(`${this.label}: cannot cancel an inactive unwind`);
    }
    this.release();
  }

  abortAndRelease(requestedNextFrame?: number, cause?: unknown): never {
    const details = `committed_frames=${this.committedFrames} committed_bytes=${this.committedBytes}`
      + (requestedNextFrame === undefined ? "" : ` requested_next_frame=${requestedNextFrame}`)
      + (cause === undefined
        ? ""
        : ` allocator_error=${cause instanceof Error ? cause.message : String(cause)}`);
    try {
      this.release();
    } finally {
      throw new Error(`${this.label}: continuation allocation failed (${details})`);
    }
  }

  moduleBufferAddress(): number {
    if (this.root === 0) throw new Error(`${this.label}: no active linked continuation`);
    return this.root + this.format.chunkHeaderSize;
  }

  hasActiveContinuation(): boolean {
    return this.root !== 0;
  }

  private allocateChunk(capacity: number, root: number, previous: number): number {
    let addr: number;
    try {
      addr = this.allocate(capacity);
    } catch (error) {
      if (error instanceof ContinuationAllocationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${this.label}: continuation allocation of ${capacity} bytes failed: ${message}`,
      );
    }
    if (
      !Number.isSafeInteger(addr)
      || addr <= 0
      || addr % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, capacity) > this.memory.buffer.byteLength
    ) {
      if (Number.isSafeInteger(addr) && addr > 0) {
        try { this.deallocate(addr, capacity); } catch { /* preserve allocator diagnosis */ }
      }
      throw new Error(`${this.label}: allocator returned invalid continuation chunk 0x${addr.toString(16)}`);
    }
    const view = this.view();
    view.setUint32(addr, CHUNK_MAGIC, true);
    view.setUint16(addr + 4, LINKED_FRAME_FORMAT_VERSION, true);
    view.setUint16(addr + 6, 0, true);
    this.writePtr(addr + 8, root || addr);
    this.writePtr(addr + 8 + this.format.ptrWidth, previous);
    this.writePtr(addr + 8 + 2 * this.format.ptrWidth, 0);
    this.writePtr(addr + 8 + 3 * this.format.ptrWidth, capacity);
    this.writePtr(addr + 8 + 4 * this.format.ptrWidth, this.format.chunkHeaderSize);
    this.writePtr(addr + 8 + 5 * this.format.ptrWidth, 0);
    this.chunks.push({ addr, size: capacity });
    return addr;
  }

  private validateChunk(addr: number, root: number, previous: number): void {
    const view = this.view();
    if (
      !Number.isSafeInteger(addr)
      || addr <= 0
      || checkedEnd(addr, this.format.chunkHeaderSize) > this.memory.buffer.byteLength
      || view.getUint32(addr, true) !== CHUNK_MAGIC
      || view.getUint16(addr + 4, true) !== LINKED_FRAME_FORMAT_VERSION
      || view.getUint16(addr + 6, true) !== 0
      || this.readPtr(addr + 8) !== root
      || this.readPtr(addr + 8 + this.format.ptrWidth) !== previous
    ) {
      throw new Error(`${this.label}: invalid linked continuation chunk at 0x${addr.toString(16)}`);
    }
    const capacity = this.readPtr(addr + 8 + 3 * this.format.ptrWidth);
    const used = this.readPtr(addr + 8 + 4 * this.format.ptrWidth);
    if (
      capacity < this.format.chunkHeaderSize
      || checkedEnd(addr, capacity) > this.memory.buffer.byteLength
      || used < this.format.chunkHeaderSize
      || used > capacity
    ) {
      throw new Error(`${this.label}: invalid linked continuation chunk bounds`);
    }
  }

  private chunkContaining(addr: number): { addr: number; size: number } {
    const chunk = this.chunks.find(({ addr: base, size }) => addr >= base && addr < base + size);
    if (!chunk) {
      throw new Error(`${this.label}: frame pointer is outside the continuation chunks`);
    }
    return chunk;
  }

  private release(): void {
    const chunks = this.chunks.splice(0).reverse();
    this.pending = null;
    this.root = 0;
    this.activeChunk = 0;
    this.replayNode = 0;
    this.abortFailure = null;
    let firstError: unknown;
    for (const chunk of chunks) {
      try {
        this.deallocate(chunk.addr, chunk.size);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private releaseAfterFailure(error: unknown): never {
    try {
      this.release();
    } catch (releaseError) {
      throw new Error(
        `${this.label}: continuation cleanup after allocation failure failed: ` +
          `${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
    }
    throw error;
  }

  private view(): DataView {
    return new DataView(this.memory.buffer);
  }

  private readPtr(addr: number): number {
    const value = this.format.ptrWidth === 8
      ? Number(this.view().getBigUint64(addr, true))
      : this.view().getUint32(addr, true);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${this.label}: continuation pointer exceeds JavaScript addressability`);
    }
    return value;
  }

  private writePtr(addr: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${this.label}: invalid continuation pointer value ${value}`);
    }
    if (this.format.ptrWidth === 8) this.view().setBigUint64(addr, BigInt(value), true);
    else this.view().setUint32(addr, value, true);
  }

  private fromGuestPtr(value: number | bigint): number {
    const number = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${this.label}: invalid guest pointer value ${String(value)}`);
    }
    return number;
  }

  private asGuestPtr(value: number): number | bigint {
    return this.format.ptrWidth === 8 ? BigInt(value) : value;
  }
}
