/**
 * Shared-memory channel for communication between the OpfsFileSystem
 * (kernel worker) and the OpfsProxyWorker (dedicated OPFS worker).
 *
 * Memory layout:
 *
 *   Offset  Size   Field
 *   0       4B     status (IDLE=0, PENDING=1, COMPLETE=2, ERROR=3)
 *   4       4B     opcode
 *   8       48B    args (12 × i32)
 *   56      4B     result / i64 result low word
 *   60      4B     result2 / i64 result high word
 *   64      ...    data section (path strings, read/write buffers)
 */

import { joinSafeI64, splitSafeI64 } from "./i64";
import type { StatResult } from "../types";
import { readOpfsStatResult, writeOpfsStatResult } from "./opfs-stat";

const STATUS_OFFSET = 0;
const OPCODE_OFFSET = 4;
const ARGS_OFFSET = 8;
const ARGS_COUNT = 12;
const RESULT_OFFSET = 56;
const RESULT2_OFFSET = 60;
const DATA_OFFSET = 64;

export const enum OpfsChannelStatus {
  Idle = 0,
  Pending = 1,
  Complete = 2,
  Error = 3,
}

export const enum OpfsOpcode {
  OPEN = 1,
  CLOSE = 2,
  READ = 3,
  WRITE = 4,
  SEEK = 5,
  FSTAT = 6,
  FTRUNCATE = 7,
  FSYNC = 8,
  STAT = 9,
  LSTAT = 10,
  MKDIR = 11,
  RMDIR = 12,
  UNLINK = 13,
  RENAME = 14,
  ACCESS = 15,
  OPENDIR = 16,
  READDIR = 17,
  CLOSEDIR = 18,
  STATFS = 19,
}

/** Default SAB size: 4 MB */
export const OPFS_CHANNEL_SIZE = 4 * 1024 * 1024;

export class OpfsChannel {
  private readonly i32: Int32Array;
  private readonly view: DataView;
  readonly buffer: SharedArrayBuffer;

  constructor(buffer: SharedArrayBuffer) {
    this.buffer = buffer;
    this.i32 = new Int32Array(buffer);
    this.view = new DataView(buffer);
  }

  // --- Status ---

  get status(): OpfsChannelStatus {
    return Atomics.load(this.i32, STATUS_OFFSET / 4) as OpfsChannelStatus;
  }

  set status(value: OpfsChannelStatus) {
    Atomics.store(this.i32, STATUS_OFFSET / 4, value);
  }

  // --- Opcode ---

  get opcode(): OpfsOpcode {
    return this.view.getInt32(OPCODE_OFFSET, true) as OpfsOpcode;
  }

  set opcode(value: OpfsOpcode) {
    this.view.setInt32(OPCODE_OFFSET, value, true);
  }

  // --- Args ---

  getArg(index: number): number {
    return this.view.getInt32(ARGS_OFFSET + index * 4, true);
  }

  setArg(index: number, value: number): void {
    this.view.setInt32(ARGS_OFFSET + index * 4, value, true);
  }

  setI64Arg(index: number, value: number): void {
    const [low, high] = splitSafeI64(value);
    this.setArg(index, low);
    this.setArg(index + 1, high);
  }

  getI64Arg(index: number): number {
    return joinSafeI64(this.getArg(index), this.getArg(index + 1));
  }

  // --- Result ---

  get result(): number {
    return this.view.getInt32(RESULT_OFFSET, true);
  }

  set result(value: number) {
    this.view.setInt32(RESULT_OFFSET, value, true);
  }

  get result2(): number {
    return this.view.getInt32(RESULT2_OFFSET, true);
  }

  set result2(value: number) {
    this.view.setInt32(RESULT2_OFFSET, value, true);
  }

  get i64Result(): number {
    return joinSafeI64(this.result, this.result2);
  }

  set i64Result(value: number) {
    const [low, high] = splitSafeI64(value);
    this.result = low;
    this.result2 = high;
  }

  // --- Data section ---

  get dataBuffer(): Uint8Array {
    return new Uint8Array(this.buffer, DATA_OFFSET);
  }

  get dataCapacity(): number {
    return this.buffer.byteLength - DATA_OFFSET;
  }

  /** Write a UTF-8 string into the data section. Returns bytes written. */
  writeString(str: string): number {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const data = this.dataBuffer;
    data.set(bytes);
    return bytes.length;
  }

  /** Read a UTF-8 string from the data section, up to `length` bytes. */
  readString(length: number): string {
    const decoder = new TextDecoder();
    const bytes = new Uint8Array(this.buffer, DATA_OFFSET, length).slice();
    return decoder.decode(bytes);
  }

  /**
   * Write two null-separated strings (for rename: oldPath\0newPath).
   * Returns total bytes written.
   */
  writeTwoStrings(s1: string, s2: string): number {
    const encoder = new TextEncoder();
    const b1 = encoder.encode(s1);
    const b2 = encoder.encode(s2);
    const data = this.dataBuffer;
    data.set(b1);
    data[b1.length] = 0; // null separator
    data.set(b2, b1.length + 1);
    return b1.length + 1 + b2.length;
  }

  /**
   * Read two null-separated strings from the data section.
   */
  readTwoStrings(totalLength: number): [string, string] {
    const data = new Uint8Array(this.buffer, DATA_OFFSET, totalLength).slice();
    const nullIdx = data.indexOf(0);
    const decoder = new TextDecoder();
    const s1 = decoder.decode(data.subarray(0, nullIdx));
    const s2 = decoder.decode(data.subarray(nullIdx + 1));
    return [s1, s2];
  }

  // --- Stat result serialization (written into data section) ---
  // Layout: dev/ino as 2 × uint64, then 8 × float64 numeric fields (80 bytes).

  writeStatResult(stat: StatResult): void {
    writeOpfsStatResult(this.buffer, DATA_OFFSET, stat);
  }

  readStatResult(): StatResult {
    return readOpfsStatResult(this.buffer, DATA_OFFSET);
  }

  writeStatfsResult(statfs: {
    type: number;
    bsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
    fsid: number;
    namelen: number;
    frsize: number;
    flags: number;
  }): void {
    const f64 = new Float64Array(this.buffer, DATA_OFFSET, 11);
    f64[0] = statfs.type;
    f64[1] = statfs.bsize;
    f64[2] = statfs.blocks;
    f64[3] = statfs.bfree;
    f64[4] = statfs.bavail;
    f64[5] = statfs.files;
    f64[6] = statfs.ffree;
    f64[7] = statfs.fsid;
    f64[8] = statfs.namelen;
    f64[9] = statfs.frsize;
    f64[10] = statfs.flags;
  }

  readStatfsResult(): {
    type: number;
    bsize: number;
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
    fsid: number;
    namelen: number;
    frsize: number;
    flags: number;
  } {
    const f64 = new Float64Array(this.buffer, DATA_OFFSET, 11);
    return {
      type: f64[0],
      bsize: f64[1],
      blocks: f64[2],
      bfree: f64[3],
      bavail: f64[4],
      files: f64[5],
      ffree: f64[6],
      fsid: f64[7],
      namelen: f64[8],
      frsize: f64[9],
      flags: f64[10],
    };
  }

  // --- Atomic synchronization ---

  /** Block until status transitions away from Pending. */
  waitForComplete(): OpfsChannelStatus {
    while (true) {
      const current = Atomics.load(this.i32, STATUS_OFFSET / 4) as OpfsChannelStatus;
      if (current === OpfsChannelStatus.Complete || current === OpfsChannelStatus.Error) {
        return current;
      }
      Atomics.wait(this.i32, STATUS_OFFSET / 4, current, 1000);
    }
  }

  /** Set status to Complete and wake waiters. */
  notifyComplete(): void {
    Atomics.store(this.i32, STATUS_OFFSET / 4, OpfsChannelStatus.Complete);
    Atomics.notify(this.i32, STATUS_OFFSET / 4);
  }

  /** Set status to Error and wake waiters. */
  notifyError(): void {
    Atomics.store(this.i32, STATUS_OFFSET / 4, OpfsChannelStatus.Error);
    Atomics.notify(this.i32, STATUS_OFFSET / 4);
  }

  /** Set status to Pending and wake the proxy worker. */
  setPending(): void {
    Atomics.store(this.i32, STATUS_OFFSET / 4, OpfsChannelStatus.Pending);
    Atomics.notify(this.i32, STATUS_OFFSET / 4);
  }
}
