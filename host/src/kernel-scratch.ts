/**
 * Capacity-carrying views of kernel-owned WebAssembly scratch allocations.
 *
 * A pointer being inside WebAssembly.Memory proves only that the host can
 * address those bytes. It does not prove that the allocator gave those bytes
 * to this caller. Keep the allocation's capacity beside its pointer and check
 * both facts independently for every transfer.
 */

export type WasmPointer = number | bigint;
export type WasmPointerWidth = 4 | 8;

const WASM32_MAX_POINTER = 0xffff_ffff;

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

/**
 * DataView-shaped access that remains tied to one active scratch lease.
 *
 * A native DataView cannot be revoked after it escapes a callback. Recreate
 * the native view for every operation instead, so post-lease use fails and an
 * in-lease memory.grow() cannot leave callers writing through a detached view.
 */
export class KernelScratchDataView {
  constructor(
    private readonly currentView: () => DataView,
  ) {}

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

export function checkedWasmPointer(
  value: WasmPointer,
  pointerWidth: WasmPointerWidth,
  field: string,
): number {
  return exactPointer(value, pointerWidth, field);
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
 * Methods recheck both allocation capacity and the current memory buffer.
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

  address(offset = 0, length = 0): number {
    return this.ownedRange(offset, length).pointer;
  }

  dataView(offset: number, length: number): KernelScratchDataView {
    // Validate at construction for fail-fast layout checks, then repeat the
    // same proof for every operation so the view is revocable and grow-safe.
    this.ownedRange(offset, length);
    return new KernelScratchDataView(() => {
      const range = this.ownedRange(offset, length);
      return new DataView(
        this.currentMemoryBuffer(),
        range.pointer,
        range.length,
      );
    });
  }

  copyFrom(
    source: Uint8Array,
    destinationOffset = 0,
    sourceOffset = 0,
    length = source.byteLength - sourceOffset,
  ): void {
    const checkedSourceOffset = exactNonNegativeInteger(
      sourceOffset,
      `${this.label} source offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length,
      `${this.label} copy length`,
    );
    checkedRange(
      checkedSourceOffset,
      checkedLength,
      source.byteLength,
      `${this.label} source`,
    );
    const destination = this.ownedRange(destinationOffset, checkedLength);
    new Uint8Array(this.currentMemoryBuffer()).set(
      source.subarray(
        checkedSourceOffset,
        checkedSourceOffset + checkedLength,
      ),
      destination.pointer,
    );
  }

  copyTo(
    destination: Uint8Array,
    sourceOffset = 0,
    destinationOffset = 0,
    length = destination.byteLength - destinationOffset,
  ): void {
    const checkedDestinationOffset = exactNonNegativeInteger(
      destinationOffset,
      `${this.label} destination offset`,
    );
    const checkedLength = exactNonNegativeInteger(
      length,
      `${this.label} copy length`,
    );
    checkedRange(
      checkedDestinationOffset,
      checkedLength,
      destination.byteLength,
      `${this.label} destination`,
    );
    const source = this.ownedRange(sourceOffset, checkedLength);
    destination.set(
      new Uint8Array(
        this.currentMemoryBuffer(),
        source.pointer,
        source.length,
      ),
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

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly pointer: number,
    readonly capacity: number,
    private readonly pointerWidth: WasmPointerWidth,
    private readonly label: string,
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
    const pointer = exactPointer(
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
    const pointer = exactPointer(
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
    if (this.activeLeaseToken !== null) {
      throw new KernelScratchError(`${this.label} is already in use`);
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
    try {
      const result = operation(lease);
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        // WHY: a retained view or callback could otherwise resume after a
        // second operation has replaced the shared bytes.
        throw new KernelScratchError(
          `${this.label} leases must remain synchronous`,
        );
      }
      return result;
    } finally {
      lease.invalidate();
      this.activeLeaseToken = null;
    }
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
 * Create a capacity-carrying region from a kernel-owned reusable reservation.
 * The kernel may move the allocation only while `reserver` runs; callers must
 * hold no older lease across this synchronous operation.
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
