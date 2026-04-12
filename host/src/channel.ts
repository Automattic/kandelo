/**
 * Shared-memory syscall channel for communication between the Wasm
 * userspace module and the host kernel.
 *
 * Memory layout (must match `wasm_posix_shared::channel`, wasm64 LP64):
 *
 *   Offset  Size  Field
 *   0..3    4B    status (IDLE=0, PENDING=1, COMPLETE=2, ERROR=3)
 *   4..7    4B    syscall number
 *   8..55   48B   arguments (6 x i64)
 *   56..63  8B    return value (i64)
 *   64..67  4B    errno
 *   68..71  4B    padding
 *   72..N         data transfer buffer
 */

/** Byte offsets matching `wasm_posix_shared::channel`. */
const STATUS_OFFSET = 0;
const SYSCALL_OFFSET = 4;
const ARGS_OFFSET = 8;
const ARGS_COUNT = 6;
const ARG_SIZE = 8; // i64
const RETURN_OFFSET = 56;
const ERRNO_OFFSET = 64;
const DATA_OFFSET = 72;

export const enum ChannelStatus {
  Idle = 0,
  Pending = 1,
  Complete = 2,
  Error = 3,
}

export class SyscallChannel {
  private readonly view: DataView;
  private readonly i32Array: Int32Array;
  private readonly buffer: SharedArrayBuffer | ArrayBuffer;
  private readonly byteOffset: number;

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, byteOffset = 0) {
    this.buffer = buffer;
    this.byteOffset = byteOffset;
    this.view = new DataView(buffer, byteOffset);
    // Int32Array for Atomics operations on the status field.
    // We create it over the entire channel so index 0 corresponds to
    // STATUS_OFFSET (byte 0) in Int32Array element terms.
    this.i32Array = new Int32Array(buffer, byteOffset);
  }

  // ---- Status field (offset 0, 4 bytes) ----

  get status(): ChannelStatus {
    if (this.isShared) {
      return Atomics.load(this.i32Array, STATUS_OFFSET / 4) as ChannelStatus;
    }
    return this.view.getUint32(STATUS_OFFSET, true) as ChannelStatus;
  }

  set status(value: ChannelStatus) {
    if (this.isShared) {
      Atomics.store(this.i32Array, STATUS_OFFSET / 4, value);
    } else {
      this.view.setUint32(STATUS_OFFSET, value, true);
    }
  }

  // ---- Syscall number (offset 4, 4 bytes) ----

  get syscallNumber(): number {
    return this.view.getUint32(SYSCALL_OFFSET, true);
  }

  // ---- Arguments (offset 8, 6 x 8 bytes = 48 bytes) ----
  // Args are i64 on wasm64. We read as BigInt64 and convert to Number
  // (safe for values < 2^53, which covers all current addresses).

  getArg(index: number): number {
    if (index < 0 || index >= ARGS_COUNT) {
      throw new RangeError(
        `Argument index ${index} out of range [0, ${ARGS_COUNT})`,
      );
    }
    return Number(this.view.getBigInt64(ARGS_OFFSET + index * ARG_SIZE, true));
  }

  /** Get arg as BigInt (for values that may exceed Number.MAX_SAFE_INTEGER). */
  getArgBigInt(index: number): bigint {
    if (index < 0 || index >= ARGS_COUNT) {
      throw new RangeError(
        `Argument index ${index} out of range [0, ${ARGS_COUNT})`,
      );
    }
    return this.view.getBigInt64(ARGS_OFFSET + index * ARG_SIZE, true);
  }

  // ---- Return value (offset 56, 8 bytes) ----

  setReturn(value: number): void {
    this.view.setBigInt64(RETURN_OFFSET, BigInt(value), true);
  }

  // ---- Errno (offset 64, 4 bytes) ----

  setErrno(value: number): void {
    this.view.setUint32(ERRNO_OFFSET, value, true);
  }

  // ---- Data transfer buffer (offset 72..end) ----

  get dataBuffer(): Uint8Array {
    return new Uint8Array(
      this.buffer,
      this.byteOffset + DATA_OFFSET,
    );
  }

  // ---- Atomic operations for SharedArrayBuffer paths ----

  /**
   * Set status to Complete and wake any thread waiting on the status field.
   * Only meaningful when the underlying buffer is a SharedArrayBuffer.
   */
  notifyComplete(): void {
    if (!this.isShared) {
      this.status = ChannelStatus.Complete;
      return;
    }
    Atomics.store(this.i32Array, STATUS_OFFSET / 4, ChannelStatus.Complete);
    Atomics.notify(this.i32Array, STATUS_OFFSET / 4);
  }

  /**
   * Set status to Error and wake any thread waiting on the status field.
   * Only meaningful when the underlying buffer is a SharedArrayBuffer.
   */
  notifyError(): void {
    if (!this.isShared) {
      this.status = ChannelStatus.Error;
      return;
    }
    Atomics.store(this.i32Array, STATUS_OFFSET / 4, ChannelStatus.Error);
    Atomics.notify(this.i32Array, STATUS_OFFSET / 4);
  }

  /**
   * Block the current thread until the channel status transitions to
   * Complete or Error. Returns the final status.
   *
   * Only works with SharedArrayBuffer (requires Atomics.wait support).
   */
  waitForComplete(): ChannelStatus {
    if (!this.isShared) {
      return this.status;
    }

    // Spin on Atomics.wait until status is no longer Pending.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const current = Atomics.load(
        this.i32Array,
        STATUS_OFFSET / 4,
      ) as ChannelStatus;
      if (
        current === ChannelStatus.Complete ||
        current === ChannelStatus.Error
      ) {
        return current;
      }
      // Wait for a change from the current value. Timeout after 1 second
      // and re-check to avoid indefinite blocking on spurious wakeups.
      Atomics.wait(this.i32Array, STATUS_OFFSET / 4, current, 1000);
    }
  }

  // ---- Helpers ----

  private get isShared(): boolean {
    return this.buffer instanceof SharedArrayBuffer;
  }
}
