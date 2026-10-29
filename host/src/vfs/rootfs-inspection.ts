import { ERRNO, STRUCT_SIZE_WASM_STAT } from "../generated/abi";
import { KernelScratchError } from "../kernel-scratch";
import type { VfsDirEntrySnapshot, VfsPathStat } from "./vfs";

/** Decode copied kernel metadata; this module owns no filesystem state. */
export function decodeInspectionStat(view: Pick<DataView, "byteLength" | "getBigInt64" | "getUint32">): VfsPathStat {
  if (view.byteLength < STRUCT_SIZE_WASM_STAT) {
    throw new KernelScratchError("Truncated inspection stat", ERRNO.EIO);
  }
  const size = view.getBigInt64(32, true);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KernelScratchError("Inspection file size exceeds host precision", ERRNO.EOVERFLOW);
  }
  return {
    mode: view.getUint32(16, true),
    uid: view.getUint32(24, true),
    gid: view.getUint32(28, true),
    size: Number(size),
  };
}

/**
 * What identifies a file and its content without reading it: device and
 * inode name the file, and size, modification time and change time move
 * whenever its bytes or metadata are written. Change time cannot be set by
 * a guest, so restoring an old modification time still shows.
 */
export interface VfsFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeSec: bigint;
  readonly mtimeNsec: number;
  readonly ctimeSec: bigint;
  readonly ctimeNsec: number;
}

/** Decode the identity fields of copied kernel metadata (`WasmStat`). */
export function decodeInspectionIdentity(
  view: Pick<DataView, "byteLength" | "getBigUint64" | "getUint32">,
): VfsFileIdentity {
  if (view.byteLength < STRUCT_SIZE_WASM_STAT) {
    throw new KernelScratchError("Truncated inspection stat", ERRNO.EIO);
  }
  // WasmStat (crates/shared): st_dev 0, st_ino 8, st_size 32,
  // st_mtime_sec 56, st_mtime_nsec 64, st_ctime_sec 72, st_ctime_nsec 80.
  return {
    dev: view.getBigUint64(0, true),
    ino: view.getBigUint64(8, true),
    size: view.getBigUint64(32, true),
    mtimeSec: view.getBigUint64(56, true),
    mtimeNsec: view.getUint32(64, true),
    ctimeSec: view.getBigUint64(72, true),
    ctimeNsec: view.getUint32(80, true),
  };
}

/** Whether two identities name the same, unmodified file. */
export function sameFileIdentity(a: VfsFileIdentity, b: VfsFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeSec === b.mtimeSec && a.mtimeNsec === b.mtimeNsec &&
    a.ctimeSec === b.ctimeSec && a.ctimeNsec === b.ctimeNsec;
}

class InspectionReader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean { return this.at === this.bytes.byteLength; }
  private take(length: number): Uint8Array {
    if (length > this.bytes.byteLength - this.at) {
      throw new KernelScratchError("Truncated inspection snapshot", ERRNO.EIO);
    }
    const bytes = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return bytes;
  }
  text(): string {
    const lengthBytes = this.take(4);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, true);
    return new TextDecoder().decode(this.take(length));
  }
  size(): number {
    const bytes = this.take(8);
    const size = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new KernelScratchError("Lazy resource exceeds host precision", ERRNO.EOVERFLOW);
    }
    return Number(size);
  }
  stat(): VfsPathStat {
    const bytes = this.take(STRUCT_SIZE_WASM_STAT);
    return decodeInspectionStat(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }
}

export function decodeInspectionDirectory(bytes: Uint8Array): VfsDirEntrySnapshot[] {
  const reader = new InspectionReader(bytes);
  const entries: VfsDirEntrySnapshot[] = [];
  while (!reader.done) {
    const name = reader.text();
    const stat = reader.stat();
    const target = reader.text();
    entries.push({ name, ...stat, ...(target === "" ? {} : { target }) });
  }
  return entries;
}

export function decodeInspectionResourceLimits(bytes: Uint8Array): Map<string, number> {
  const reader = new InspectionReader(bytes);
  const resources = new Map<string, number>();
  while (!reader.done) resources.set(reader.text(), reader.size());
  return resources;
}
