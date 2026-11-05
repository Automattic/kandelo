import { ERRNO } from "../../../host/src/generated/abi";
import type { PersistentOverlayStorage } from "../../../host/src/vfs/overlay-storage";

export type PositionedImageTarget = Omit<PersistentOverlayStorage, "close">;

function failure(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && Object.hasOwn(ERRNO, code)) {
    return -(ERRNO as Record<string, number>)[code];
  }
  if ((error as { name?: unknown } | null)?.name === "QuotaExceededError") return -ERRNO.ENOSPC;
  return -ERRNO.EIO;
}

export class PositionedImageTargets {
  private nextToken = 1;
  private active: { token: number; target: PositionedImageTarget } | null = null;
  private attaching = false;

  constructor(private readonly memory: () => WebAssembly.Memory | undefined) {}

  attach(target: PositionedImageTarget): number {
    if (this.active !== null || this.attaching) throw new Error("Persistent image target is busy");
    if (this.nextToken > 0xffff_ffff) throw new Error("Persistent image target tokens exhausted");
    this.attaching = true;
    try {
      const snapshot = Object.freeze({
        len: target.len.bind(target),
        readExactAt: target.readExactAt.bind(target),
        writeAllAt: target.writeAllAt.bind(target),
        truncate: target.truncate.bind(target),
        flush: target.flush.bind(target),
      });
      const token = this.nextToken++;
      this.active = { token, target: snapshot };
      return token;
    } finally { this.attaching = false; }
  }

  detach(token: number): void {
    if (this.active?.token !== token) throw new Error("Persistent image target owner mismatch");
    this.active = null;
  }

  private target(token: number): PositionedImageTarget {
    if (this.active?.token !== (token >>> 0)) throw Object.assign(new Error("Stale image target"), { code: "EBADF" });
    return this.active.target;
  }

  private position(offset: bigint): number {
    const value = Number(offset);
    if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error("Invalid image position"), { code: "EOVERFLOW" });
    return value;
  }

  private bytes(pointer: number, length: number): Uint8Array {
    const memory = this.memory();
    const start = pointer >>> 0;
    const count = length >>> 0;
    if (memory === undefined || count > 65536 || start + count > memory.buffer.byteLength) {
      throw Object.assign(new Error("Invalid image byte window"), { code: "EFAULT" });
    }
    return new Uint8Array(memory.buffer, start, count);
  }

  readonly imports = {
    host_image_target_size: (token: number): bigint => {
      try {
        const size = this.target(token).len();
        if (!Number.isSafeInteger(size) || size < 0) return BigInt(-ERRNO.EOVERFLOW);
        return BigInt(size);
      } catch (error) { return BigInt(failure(error)); }
    },
    host_image_target_write: (token: number, offset: bigint, pointer: number, length: number): number => {
      try {
        const target = this.target(token);
        const position = this.position(offset);
        const bytes = this.bytes(pointer, length);
        if (!Number.isSafeInteger(position + bytes.length)) return -ERRNO.EOVERFLOW;
        if (target.writeAllAt(position, bytes) !== undefined) return -ERRNO.EIO;
        return bytes.length;
      } catch (error) { return failure(error); }
    },
    host_image_target_read: (token: number, offset: bigint, pointer: number, length: number): number => {
      try {
        const target = this.target(token);
        const position = this.position(offset);
        const bytes = this.bytes(pointer, length);
        if (!Number.isSafeInteger(position + bytes.length)) return -ERRNO.EOVERFLOW;
        if (target.readExactAt(position, bytes) !== undefined) return -ERRNO.EIO;
        return bytes.length;
      } catch (error) { return failure(error); }
    },
    host_image_target_truncate: (token: number, length: bigint): number => {
      try { return this.target(token).truncate(this.position(length)) === undefined ? 0 : -ERRNO.EIO; }
      catch (error) { return failure(error); }
    },
    host_image_target_flush: (token: number): number => {
      try { return this.target(token).flush() === undefined ? 0 : -ERRNO.EIO; }
      catch (error) { return failure(error); }
    },
  };
}
