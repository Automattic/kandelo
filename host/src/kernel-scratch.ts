/**
 * Capacity-carrying views of kernel-owned WebAssembly scratch allocations.
 *
 * A pointer being inside WebAssembly.Memory proves only that the host can
 * address those bytes. It does not prove that the allocator gave those bytes
 * to this caller. Keep the allocation's capacity beside its pointer and check
 * both facts independently for every transfer.
 */

import {
  checkedWasmGuestPointerOffset,
} from "./wasm-guest-pointer";

export type WasmPointer = number | bigint;
export type WasmPointerWidth = 4 | 8;

const WASM32_MAX_POINTER = 0xffff_ffff;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;

export class KernelScratchError extends Error {
  constructor(
    message: string,
    readonly errno = 14,
  ) {
    super(message);
    this.name = "KernelScratchError";
  }
}

export interface CheckedMemoryRange {
  pointer: number;
  length: number;
  end: number;
}

function intrinsicUint8ArraySpan(
  value: Uint8Array,
  field: string,
): {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
} {
  try {
    return {
      buffer: typedArrayBuffer.call(value) as ArrayBufferLike,
      byteOffset: typedArrayByteOffset.call(value) as number,
      byteLength: typedArrayByteLength.call(value) as number,
    };
  } catch {
    throw new KernelScratchError(`${field} is not a genuine Uint8Array`);
  }
}

/**
 * Return a base-class view over the exact intrinsic bytes of a Uint8Array.
 *
 * WHY: a subclass can override `byteLength`, `length`, or `subarray` while
 * native TypedArray#set still consumes its real internal span. Producers at a
 * host boundary must therefore be normalized before their size is trusted or
 * their bytes are copied into an owned kernel allocation.
 */
export function intrinsicUint8ArrayView(
  value: Uint8Array,
  field: string,
): Uint8Array {
  const span = intrinsicUint8ArraySpan(value, field);
  return new Uint8Array(
    span.buffer,
    span.byteOffset,
    span.byteLength,
  );
}

/**
 * DataView-shaped access that remains tied to one active scratch lease.
 *
 * A native DataView cannot be revoked after it escapes a callback, so it stays
 * private behind methods that assert the lease on every access. Reuse is safe
 * only while WebAssembly.Memory exposes the same buffer; memory.grow() replaces
 * that buffer and forces a checked refresh before the next access.
 */
export class KernelScratchDataView {
  private cachedBuffer: ArrayBufferLike;
  private cachedView: DataView;

  constructor(
    private readonly activeMemoryBuffer: () => ArrayBufferLike,
    private readonly refreshView: () => {
      buffer: ArrayBufferLike;
      view: DataView;
    },
  ) {
    const initial = refreshView();
    this.cachedBuffer = initial.buffer;
    this.cachedView = initial.view;
  }

  private currentView(): DataView {
    // WHY: checking the lease even on a cache hit is what makes an escaped
    // wrapper revocable. Returning the cached native view directly would let
    // callers use scratch bytes after a later operation had replaced them.
    const buffer = this.activeMemoryBuffer();
    if (buffer !== this.cachedBuffer) {
      // WHY: WebAssembly memory growth replaces the exposed buffer. Repeat the
      // full allocation-capacity and current-memory proof before caching a view
      // over the replacement instead of assuming total memory size is enough.
      const refreshed = this.refreshView();
      this.cachedBuffer = refreshed.buffer;
      this.cachedView = refreshed.view;
    }
    return this.cachedView;
  }

  get byteLength(): number {
    return this.currentView().byteLength;
  }

  getBigInt64(byteOffset: number, littleEndian?: boolean): bigint {
    return this.currentView().getBigInt64(byteOffset, littleEndian);
  }

  getBigUint64(byteOffset: number, littleEndian?: boolean): bigint {
    return this.currentView().getBigUint64(byteOffset, littleEndian);
  }

  getFloat32(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getFloat32(byteOffset, littleEndian);
  }

  getFloat64(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getFloat64(byteOffset, littleEndian);
  }

  getInt8(byteOffset: number): number {
    return this.currentView().getInt8(byteOffset);
  }

  getInt16(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getInt16(byteOffset, littleEndian);
  }

  getInt32(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getInt32(byteOffset, littleEndian);
  }

  getUint8(byteOffset: number): number {
    return this.currentView().getUint8(byteOffset);
  }

  getUint16(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getUint16(byteOffset, littleEndian);
  }

  getUint32(byteOffset: number, littleEndian?: boolean): number {
    return this.currentView().getUint32(byteOffset, littleEndian);
  }

  setBigInt64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void {
    this.currentView().setBigInt64(byteOffset, value, littleEndian);
  }

  setBigUint64(
    byteOffset: number,
    value: bigint,
    littleEndian?: boolean,
  ): void {
    this.currentView().setBigUint64(byteOffset, value, littleEndian);
  }

  setFloat32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setFloat32(byteOffset, value, littleEndian);
  }

  setFloat64(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setFloat64(byteOffset, value, littleEndian);
  }

  setInt8(byteOffset: number, value: number): void {
    this.currentView().setInt8(byteOffset, value);
  }

  setInt16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setInt16(byteOffset, value, littleEndian);
  }

  setInt32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setInt32(byteOffset, value, littleEndian);
  }

  setUint8(byteOffset: number, value: number): void {
    this.currentView().setUint8(byteOffset, value);
  }

  setUint16(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setUint16(byteOffset, value, littleEndian);
  }

  setUint32(
    byteOffset: number,
    value: number,
    littleEndian?: boolean,
  ): void {
    this.currentView().setUint32(byteOffset, value, littleEndian);
  }
}

function exactNonNegativeInteger(
  value: number | bigint,
  field: string,
): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new KernelScratchError(
        `${field} is not losslessly representable as a host memory index`,
      );
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KernelScratchError(
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function exactPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  const pointer = exactNonNegativeInteger(value, field);
  if (pointerWidth === 4 && pointer > WASM32_MAX_POINTER) {
    throw new KernelScratchError(`${field} does not fit a wasm32 pointer`);
  }
  return pointer;
}

/**
 * Normalize a raw `usize` returned by a kernel Wasm export.
 *
 * WebAssembly exposes an i32 result to JavaScript as a signed number even
 * though a wasm32 pointer uses the same 32 bits as an unsigned address. Keep
 * this normalization confined to allocator/export results: caller-supplied
 * negative pointers remain invalid everywhere else.
 */
export function checkedKernelExportPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  if (pointerWidth === 4 && typeof value === "number" && value < 0) {
    if (!Number.isInteger(value) || value < -0x8000_0000) {
      throw new KernelScratchError(
        `${field} is not a valid wasm32 export result`,
      );
    }
    return exactPointer(value + 0x1_0000_0000, pointerWidth, field);
  }
  return exactPointer(value, pointerWidth, field);
}

export function checkedWasmPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  return exactPointer(value, pointerWidth, field);
}

/**
 * Validate a half-open address range against a guest pointer domain.
 *
 * This is deliberately separate from `checkedMemoryRange`: address-space
 * reservations may precede `memory.grow`, while a host byte transfer must
 * additionally fit the current Memory buffer. Length is pointer-sized because
 * the kernel reservation ABI transports it as `usize`.
 */
export function checkedWasmAddressRange(
  pointerValue: WasmPointer,
  lengthValue: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): CheckedMemoryRange {
  const pointer = checkedWasmPointer(
    pointerValue,
    pointerWidth,
    `${field} pointer`,
  );
  const length = checkedWasmPointer(
    lengthValue,
    pointerWidth,
    `${field} length`,
  );
  const end = pointer + length;
  const exclusiveLimit = pointerWidth === 4
    ? 0x1_0000_0000
    : Number.MAX_SAFE_INTEGER;
  if (
    !Number.isSafeInteger(end)
    || end < pointer
    || end > exclusiveLimit
  ) {
    throw new KernelScratchError(
      `${field} is outside the wasm${pointerWidth * 8} address range`,
    );
  }
  return { pointer, length, end };
}

function checkedRange(
  pointer: number,
  length: number,
  limit: number,
  field: string,
): CheckedMemoryRange {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new KernelScratchError(`${field} has an invalid range limit`);
  }
  const end = pointer + length;
  if (!Number.isSafeInteger(end) || end < pointer || end > limit) {
    throw new KernelScratchError(`${field} is outside its owned range`);
  }
  return { pointer, length, end };
}

/**
 * Validate a pointer/length pair against the current WebAssembly.Memory
 * buffer.
 *
 * Wasm linear-memory address zero is caller-addressable, even though a zero
 * returned by a kernel allocator means allocation failure. Keep that
 * distinction explicit at the call site instead of teaching range checks that
 * every address zero is a failed allocation.
 */
export function checkedMemoryRange(
  memory: WebAssembly.Memory,
  pointerValue: WasmPointer,
  lengthValue: number | bigint,
  pointerWidth: WasmPointerWidth,
  field: string,
  allowAddressZero = false,
): CheckedMemoryRange {
  const pointer = exactPointer(pointerValue, pointerWidth, `${field} pointer`);
  const length = exactNonNegativeInteger(lengthValue, `${field} length`);
  if (!allowAddressZero && pointer === 0 && length !== 0) {
    throw new KernelScratchError(`${field} uses a null pointer`);
  }
  return checkedRange(pointer, length, memory.buffer.byteLength, field);
}

/**
 * Validate a raw pointer delivered by a WebAssembly import.
 *
 * Unlike already-normalized channel values, a memory32 pointer reaches
 * JavaScript as a signed i32. Normalize those exact bits first, then perform
 * the ordinary null, length, overflow, and current-memory checks.
 */
export function checkedWasmImportMemoryRange(
  memory: WebAssembly.Memory,
  pointerValue: WasmPointer,
  lengthValue: number | bigint,
  pointerWidth: WasmPointerWidth,
  field: string,
  allowAddressZero = false,
): CheckedMemoryRange {
  let pointer: number;
  try {
    pointer = checkedWasmGuestPointerOffset(
      pointerValue,
      pointerWidth,
      `${field} pointer`,
    );
  } catch (error) {
    throw new KernelScratchError(
      `${field} has an invalid raw WebAssembly pointer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return checkedMemoryRange(
    memory,
    pointer,
    lengthValue,
    pointerWidth,
    field,
    allowAddressZero,
  );
}

export type KernelScratchAllocator = (capacity: number) => WasmPointer;
export interface KernelScratchReservation {
  pointer: WasmPointer;
  capacity: number | bigint;
}
export type KernelScratchReserver = (
  minimumCapacity: number,
) => KernelScratchReservation;

/**
 * A synchronous lease is the only way to read or write the allocation.
 * Transfers check both allocation capacity and the current memory buffer.
 * Guarded scalar views retain that proof only while the grow-only memory keeps
 * the same buffer identity, and repeat it when growth replaces the buffer.
 */
export class KernelScratchLease {
  private valid = true;

  constructor(
    private readonly label: string,
    private readonly rangeForLease: (
      offset: number,
      length: number,
    ) => CheckedMemoryRange,
    private readonly currentMemoryBuffer: () => ArrayBufferLike,
  ) {}

  invalidate(): void {
    this.valid = false;
  }

  private assertValid(): void {
    if (!this.valid) {
      throw new KernelScratchError(
        `${this.label} lease is no longer active`,
      );
    }
  }

  private ownedRange(offsetValue: number, lengthValue: number): CheckedMemoryRange {
    this.assertValid();
    const offset = exactNonNegativeInteger(
      offsetValue,
      `${this.label} offset`,
    );
    const length = exactNonNegativeInteger(
      lengthValue,
      `${this.label} length`,
    );
    return this.rangeForLease(offset, length);
  }

  address(offset: number, length: number): number {
    return this.ownedRange(offset, length).pointer;
  }

  dataView(offset: number, length: number): KernelScratchDataView {
    const refreshView = () => {
      const range = this.ownedRange(offset, length);
      const buffer = this.currentMemoryBuffer();
      return {
        buffer,
        view: new DataView(
          buffer,
          range.pointer,
          range.length,
        ),
      };
    };
    return new KernelScratchDataView(
      () => {
        this.assertValid();
        return this.currentMemoryBuffer();
      },
      refreshView,
    );
  }

  copyFrom(
    source: Uint8Array,
    destinationOffset = 0,
    sourceOffset = 0,
    length?: number,
  ): void {
    const sourceSpan = intrinsicUint8ArraySpan(
      source,
      `${this.label} source`,
    );
    const checkedSourceOffset = exactNonNegativeInteger(
      sourceOffset,
      `${this.label} source offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length ?? sourceSpan.byteLength - checkedSourceOffset,
      `${this.label} copy length`,
    );
    checkedRange(
      checkedSourceOffset,
      checkedLength,
      sourceSpan.byteLength,
      `${this.label} source`,
    );
    const destination = this.ownedRange(destinationOffset, checkedLength);
    // WHY: calling a subclass-overridable `source.subarray()` could return
    // more bytes than the range just proved. Construct an exact base-class
    // view from the typed array's intrinsic slots instead.
    const exactSource = new Uint8Array(
      sourceSpan.buffer,
      sourceSpan.byteOffset + checkedSourceOffset,
      checkedLength,
    );
    new Uint8Array(this.currentMemoryBuffer()).set(
      exactSource,
      destination.pointer,
    );
  }

  copyTo(
    destination: Uint8Array,
    sourceOffset = 0,
    destinationOffset = 0,
    length?: number,
  ): void {
    const destinationSpan = intrinsicUint8ArraySpan(
      destination,
      `${this.label} destination`,
    );
    const checkedDestinationOffset = exactNonNegativeInteger(
      destinationOffset,
      `${this.label} destination offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length ?? destinationSpan.byteLength - checkedDestinationOffset,
      `${this.label} copy length`,
    );
    checkedRange(
      checkedDestinationOffset,
      checkedLength,
      destinationSpan.byteLength,
      `${this.label} destination`,
    );
    const source = this.ownedRange(sourceOffset, checkedLength);
    // WHY: `destination` is caller-owned and a Uint8Array subclass may
    // override `set`, retain its argument, grow memory, or reenter the host.
    // Detach before invoking that external receiver so no native kernel view
    // can escape the active lease.
    const detached = new Uint8Array(
      this.currentMemoryBuffer(),
      source.pointer,
      source.length,
    ).slice();
    destination.set(
      detached,
      checkedDestinationOffset,
    );
  }

  copyOut(sourceOffset: number, length: number): Uint8Array {
    const source = this.ownedRange(sourceOffset, length);
    return new Uint8Array(
      this.currentMemoryBuffer(),
      source.pointer,
      source.length,
    ).slice();
  }

  fill(value: number, offset: number, length: number): void {
    const destination = this.ownedRange(offset, length);
    new Uint8Array(this.currentMemoryBuffer()).fill(
      value,
      destination.pointer,
      destination.end,
    );
  }
}

/**
 * Pointer plus declared capacity for one kernel-owned allocation.
 *
 * The constructor is private: production callers obtain regions only by
 * passing the kernel allocator to allocateKernelScratchRegion.
 */
export class KernelScratchRegion {
  private activeLeaseToken: object | null = null;
  private revoked = false;
  private singleUseConsumed = false;

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly pointer: number,
    readonly capacity: number,
    private readonly pointerWidth: WasmPointerWidth,
    private readonly label: string,
    private readonly leaseMode: "reusable" | "single-use",
  ) {}

  static allocate(
    memory: WebAssembly.Memory,
    allocator: KernelScratchAllocator,
    capacityValue: number,
    pointerWidth: WasmPointerWidth,
    label: string,
  ): KernelScratchRegion {
    const capacity = exactNonNegativeInteger(
      capacityValue,
      `${label} capacity`,
    );
    if (capacity === 0) {
      throw new KernelScratchError(`${label} capacity must be positive`);
    }
    if (capacity > 0xffff_ffff) {
      throw new KernelScratchError(
        `${label} capacity does not fit kernel_alloc_scratch's u32 size`,
      );
    }
    const pointer = checkedKernelExportPointer(
      allocator(capacity),
      pointerWidth,
      `${label} allocation`,
    );
    if (pointer === 0) {
      throw new KernelScratchError(`${label} allocation failed`);
    }
    checkedMemoryRange(memory, pointer, capacity, pointerWidth, label);
    return new KernelScratchRegion(
      memory,
      pointer,
      capacity,
      pointerWidth,
      label,
      "reusable",
    );
  }

  static reserve(
    memory: WebAssembly.Memory,
    reserver: KernelScratchReserver,
    minimumCapacityValue: number,
    pointerWidth: WasmPointerWidth,
    label: string,
  ): KernelScratchRegion {
    const minimumCapacity = exactNonNegativeInteger(
      minimumCapacityValue,
      `${label} minimum capacity`,
    );
    if (minimumCapacity === 0) {
      throw new KernelScratchError(
        `${label} minimum capacity must be positive`,
      );
    }
    const reservation = reserver(minimumCapacity);
    const capacity = exactNonNegativeInteger(
      reservation.capacity,
      `${label} reserved capacity`,
    );
    if (capacity < minimumCapacity) {
      throw new KernelScratchError(
        `${label} reserved capacity ${capacity} is below ${minimumCapacity}`,
      );
    }
    const pointer = checkedKernelExportPointer(
      reservation.pointer,
      pointerWidth,
      `${label} reservation`,
    );
    if (pointer === 0) {
      throw new KernelScratchError(`${label} reservation failed`);
    }
    checkedMemoryRange(memory, pointer, capacity, pointerWidth, label);
    return new KernelScratchRegion(
      memory,
      pointer,
      capacity,
      pointerWidth,
      label,
      "single-use",
    );
  }

  private assertActiveLease(token: object): void {
    if (this.activeLeaseToken !== token) {
      throw new KernelScratchError(
        `${this.label} lease is no longer active`,
      );
    }
  }

  private ownedRangeForLease(
    token: object,
    offset: number,
    length: number,
  ): CheckedMemoryRange {
    this.assertActiveLease(token);
    checkedRange(offset, length, this.capacity, this.label);
    return checkedMemoryRange(
      this.memory,
      this.pointer + offset,
      length,
      this.pointerWidth,
      this.label,
    );
  }

  withLease<T>(operation: (scratch: KernelScratchLease) => T): T {
    if (this.revoked) {
      throw new KernelScratchError(`${this.label} is no longer valid`);
    }
    if (this.leaseMode === "single-use" && this.singleUseConsumed) {
      throw new KernelScratchError(
        `${this.label} reservation is single-use`,
      );
    }
    if (this.activeLeaseToken !== null) {
      throw new KernelScratchError(`${this.label} is already in use`);
    }
    // WHY: a reservation-derived pointer can move on the next Rust reserve.
    // Consume its one lease before any fallible range/view work so retrying a
    // partially failed attempt cannot revive a stale pointer.
    if (this.leaseMode === "single-use") {
      this.singleUseConsumed = true;
    }
    // Recheck the whole allocation because memory replacement/growth changes
    // the backing buffer independently of the allocator's original result.
    checkedMemoryRange(
      this.memory,
      this.pointer,
      this.capacity,
      this.pointerWidth,
      this.label,
    );
    const token = {};
    this.activeLeaseToken = token;
    const lease = new KernelScratchLease(
      this.label,
      (offset, length) =>
        this.ownedRangeForLease(token, offset, length),
      () => {
        this.assertActiveLease(token);
        return this.memory.buffer;
      },
    );
    let result!: T;
    try {
      result = operation(lease);
    } finally {
      // WHY: revoke the lease before inspecting an arbitrary return value.
      // A hostile `then` getter must not retain scratch access for even the
      // property lookup used to reject asynchronous operations.
      lease.invalidate();
      this.activeLeaseToken = null;
    }
    if (
      (
        typeof result === "object" &&
        result !== null
      ) ||
      typeof result === "function"
    ) {
      if (typeof (result as { then?: unknown }).then === "function") {
        // WHY: a retained view or callback could otherwise resume after a
        // second operation has replaced the shared bytes.
        throw new KernelScratchError(
          `${this.label} leases must remain synchronous`,
        );
      }
    }
    return result;
  }

  /**
   * Permanently invalidate a reservation-derived region when its matching
   * kernel token is consumed or cancelled.
   */
  revoke(): void {
    if (this.activeLeaseToken !== null) {
      throw new KernelScratchError(
        `${this.label} cannot be revoked while in use`,
      );
    }
    this.revoked = true;
  }
}

export function allocateKernelScratchRegion(
  memory: WebAssembly.Memory,
  allocator: KernelScratchAllocator,
  capacity: number,
  pointerWidth: WasmPointerWidth,
  label: string,
): KernelScratchRegion {
  return KernelScratchRegion.allocate(
    memory,
    allocator,
    capacity,
    pointerWidth,
    label,
  );
}

/**
 * Create a one-shot capacity-carrying region from a kernel-owned reservation.
 * The kernel may move the allocation only while `reserver` runs. The returned
 * region permits exactly one lease and should be revoked when the matching
 * reservation token is consumed or cancelled.
 */
export function reserveKernelScratchRegion(
  memory: WebAssembly.Memory,
  reserver: KernelScratchReserver,
  minimumCapacity: number,
  pointerWidth: WasmPointerWidth,
  label: string,
): KernelScratchRegion {
  return KernelScratchRegion.reserve(
    memory,
    reserver,
    minimumCapacity,
    pointerWidth,
    label,
  );
}
