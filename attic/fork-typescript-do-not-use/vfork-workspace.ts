import type {
  ForkBorrowedReplayPrefixRequest,
} from "./fork-process-continuation";
import type { WasmGuestPointer } from "./wasm-guest-pointer";

export interface BorrowedVforkWorkspaceLayout {
  readonly prefixAddress: number;
  readonly prefixBytes: number;
  readonly scratchAddress: number;
  readonly scratchBytes: number;
}

interface ScratchReservation {
  readonly address: number;
  readonly size: number;
  readonly previousCursor: number;
}

function checkedEnd(address: number, bytes: number, label: string): number {
  if (
    !Number.isSafeInteger(address)
    || address <= 0
    || !Number.isSafeInteger(bytes)
    || bytes < 0
    || address > Number.MAX_SAFE_INTEGER - bytes
  ) {
    throw new RangeError(`${label} is not an exact guest-memory range`);
  }
  return address + bytes;
}

function alignUp(value: number, alignment: number, label: string): number {
  if (
    !Number.isSafeInteger(alignment)
    || alignment <= 0
    || (alignment & (alignment - 1)) !== 0
  ) {
    throw new RangeError(`${label} has invalid alignment ${alignment}`);
  }
  const aligned = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(aligned) || aligned < value) {
    throw new RangeError(`${label} alignment overflows guest memory`);
  }
  return aligned;
}

/**
 * Child-private mutable ranges inside a shared vfork address space.
 *
 * WHY: generated rewind mutates each activation prefix, and reference codecs
 * use nested scratch reservations. Neither may touch the suspended parent's
 * prefix or syscall channel. The host reserves these exact ranges before the
 * child Worker starts; this class never grows Memory or allocates a mapping.
 */
export class BorrowedVforkWorkspace {
  private readonly prefixEnd: number;
  private readonly scratchEnd: number;
  private prefixCursor: number;
  private scratchCursor: number;
  private readonly scratchReservations: ScratchReservation[] = [];

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly ptrWidth: 4 | 8,
    private readonly layout: BorrowedVforkWorkspaceLayout,
    private readonly label = "borrowed vfork workspace",
  ) {
    this.prefixEnd = checkedEnd(
      layout.prefixAddress,
      layout.prefixBytes,
      `${label} prefix`,
    );
    this.scratchEnd = checkedEnd(
      layout.scratchAddress,
      layout.scratchBytes,
      `${label} scratch`,
    );
    if (
      this.prefixEnd > memory.buffer.byteLength
      || this.scratchEnd > memory.buffer.byteLength
    ) {
      throw new RangeError(`${label} exceeds shared WebAssembly.Memory`);
    }
    if (
      layout.prefixBytes > 0
      && layout.scratchBytes > 0
      && layout.prefixAddress < this.scratchEnd
      && layout.scratchAddress < this.prefixEnd
    ) {
      throw new RangeError(`${label} prefix and scratch ranges overlap`);
    }
    this.prefixCursor = layout.prefixAddress;
    this.scratchCursor = layout.scratchAddress;
  }

  readonly reservePrefix = (
    request: ForkBorrowedReplayPrefixRequest,
  ): WasmGuestPointer => {
    const address = alignUp(
      this.prefixCursor,
      request.alignment,
      `${this.label} activation ${request.activationId} prefix`,
    );
    const end = checkedEnd(
      address,
      request.byteLength,
      `${this.label} activation ${request.activationId} prefix`,
    );
    if (end > this.prefixEnd) {
      throw new RangeError(
        `${this.label} activation ${request.activationId} prefix exceeds `
          + `${this.layout.prefixBytes} admitted bytes`,
      );
    }
    this.prefixCursor = end;
    return this.ptrWidth === 8 ? BigInt(address) : address;
  };

  readonly allocateScratch = (size: number): number => {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new RangeError(`${this.label} scratch size is invalid`);
    }
    const previousCursor = this.scratchCursor;
    const address = alignUp(
      previousCursor,
      16,
      `${this.label} scratch allocation`,
    );
    const end = checkedEnd(address, size, `${this.label} scratch allocation`);
    if (end > this.scratchEnd) {
      throw new RangeError(
        `${this.label} scratch allocation exceeds `
          + `${this.layout.scratchBytes} admitted bytes`,
      );
    }
    new Uint8Array(this.memory.buffer, address, size).fill(0);
    this.scratchReservations.push({ address, size, previousCursor });
    this.scratchCursor = end;
    return address;
  };

  readonly deallocateScratch = (address: number, size: number): void => {
    const reservation = this.scratchReservations.pop();
    if (
      !reservation
      || reservation.address !== address
      || reservation.size !== size
    ) {
      if (reservation) this.scratchReservations.push(reservation);
      throw new Error(`${this.label} scratch release is not LIFO-exact`);
    }
    new Uint8Array(this.memory.buffer, address, size).fill(0);
    this.scratchCursor = reservation.previousCursor;
  };

  /** Prove that capture's exact prefix measure and scratch lifetime matched. */
  assertAttachComplete(): void {
    const prefixBytes = this.prefixCursor - this.layout.prefixAddress;
    if (prefixBytes !== this.layout.prefixBytes) {
      throw new Error(
        `${this.label} consumed ${prefixBytes} prefix bytes; `
          + `admission declared ${this.layout.prefixBytes}`,
      );
    }
    if (this.scratchReservations.length !== 0) {
      throw new Error(
        `${this.label} retained ${this.scratchReservations.length} `
          + "scratch reservation(s) after attach",
      );
    }
    if (this.scratchCursor !== this.layout.scratchAddress) {
      throw new Error(`${this.label} scratch cursor did not return to its base`);
    }
  }
}
