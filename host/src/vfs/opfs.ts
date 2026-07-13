/**
 * OPFS-backed FileSystemBackend. Runs in the kernel worker thread.
 *
 * All operations serialize arguments into a SharedArrayBuffer channel,
 * then block with Atomics.wait() until the OpfsProxyWorker completes
 * the async OPFS operation.
 */
import type { PathconfValue, StatResult, StatfsResult } from "../types";
import { filesystemPathconf } from "../pathconf";
import type { FileSystemBackend, DirEntry } from "./types";
import { OpfsChannel, OpfsChannelStatus, OpfsOpcode } from "./opfs-channel";

export class OpfsFileSystem implements FileSystemBackend {
  private readonly channel: OpfsChannel;

  constructor(channel: OpfsChannel) {
    this.channel = channel;
  }

  static create(sab: SharedArrayBuffer): OpfsFileSystem {
    return new OpfsFileSystem(new OpfsChannel(sab));
  }

  /** Send an opcode and block until complete. Returns the result value. Throws on error. */
  private call(opcode: OpfsOpcode): number {
    this.channel.opcode = opcode;
    this.channel.setPending();
    const status = this.channel.waitForComplete();
    const result = this.channel.result;
    this.channel.status = OpfsChannelStatus.Idle;
    if (status === OpfsChannelStatus.Error) {
      throw this.errnoToError(result);
    }
    return result;
  }

  private errnoToError(negErrno: number): Error {
    const ERRNO_NAMES: Record<number, string> = {
      [-1]: "EPERM",
      [-2]: "ENOENT",
      [-9]: "EBADF",
      [-13]: "EACCES",
      [-17]: "EEXIST",
      [-18]: "EXDEV",
      [-20]: "ENOTDIR",
      [-21]: "EISDIR",
      [-22]: "EINVAL",
      [-28]: "ENOSPC",
      [-39]: "ENOTEMPTY",
      [-75]: "EOVERFLOW",
      [-95]: "ENOTSUP",
    };
    const name = ERRNO_NAMES[negErrno] || `errno(${negErrno})`;
    return new Error(name);
  }

  private setI64Arg(index: number, value: number): void {
    try {
      this.channel.setI64Arg(index, value);
    } catch (error) {
      if (error instanceof RangeError) throw this.errnoToError(-75);
      throw error;
    }
  }

  // --- File handle operations ---

  open(path: string, flags: number, mode: number): number {
    this.channel.setArg(0, flags);
    this.channel.setArg(1, mode);
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(2, pathLen);
    return this.call(OpfsOpcode.OPEN);
  }

  close(handle: number): number {
    this.channel.setArg(0, handle);
    this.call(OpfsOpcode.CLOSE);
    return 0;
  }

  read(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    this.channel.setArg(0, handle);
    this.channel.setArg(1, length);
    if (offset !== null) {
      this.setI64Arg(2, offset);
      this.channel.setArg(4, 1); // has_offset
    } else {
      this.channel.setArg(2, 0);
      this.channel.setArg(3, 0);
      this.channel.setArg(4, 0); // no offset
    }
    const bytesRead = this.call(OpfsOpcode.READ);
    if (bytesRead > 0) {
      buffer.set(this.channel.dataBuffer.subarray(0, bytesRead));
    }
    return bytesRead;
  }

  write(handle: number, buffer: Uint8Array, offset: number | null, length: number): number {
    this.channel.setArg(0, handle);
    this.channel.setArg(1, length);
    if (offset !== null) {
      this.setI64Arg(2, offset);
      this.channel.setArg(4, 1);
    } else {
      this.channel.setArg(2, 0);
      this.channel.setArg(3, 0);
      this.channel.setArg(4, 0);
    }
    this.channel.dataBuffer.set(buffer.subarray(0, length));
    return this.call(OpfsOpcode.WRITE);
  }

  seek(handle: number, offset: number, whence: number): number {
    this.channel.setArg(0, handle);
    this.setI64Arg(1, offset);
    this.channel.setArg(3, whence);
    this.call(OpfsOpcode.SEEK);
    try {
      return this.channel.i64Result;
    } catch (error) {
      if (error instanceof RangeError) throw this.errnoToError(-75);
      throw error;
    }
  }

  fstat(handle: number): StatResult {
    this.channel.setArg(0, handle);
    this.call(OpfsOpcode.FSTAT);
    return this.channel.readStatResult();
  }

  fpathconf(handle: number, name: number): PathconfValue {
    const stat = this.fstat(handle);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: false,
      timestampResolutionNs: null,
    });
  }

  ftruncate(handle: number, length: number): void {
    this.channel.setArg(0, handle);
    this.setI64Arg(1, length);
    this.call(OpfsOpcode.FTRUNCATE);
  }

  fsync(handle: number): void {
    this.channel.setArg(0, handle);
    this.call(OpfsOpcode.FSYNC);
  }

  fchmod(_handle: number, _mode: number): void {
    // OPFS has no permission model
  }

  fchown(_handle: number, _uid: number, _gid: number): void {
    // OPFS has no ownership model
  }

  // --- Path operations ---

  stat(path: string): StatResult {
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    this.call(OpfsOpcode.STAT);
    return this.channel.readStatResult();
  }

  lstat(path: string): StatResult {
    // OPFS has no symbolic links; lstat === stat
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    this.call(OpfsOpcode.LSTAT);
    return this.channel.readStatResult();
  }

  statfs(path: string): StatfsResult {
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    this.call(OpfsOpcode.STATFS);
    return this.channel.readStatfsResult();
  }

  pathconf(path: string, name: number): PathconfValue {
    const stat = this.stat(path);
    return filesystemPathconf(stat, name, {
      supportsSymlinks: false,
      timestampResolutionNs: null,
    });
  }

  mkdir(path: string, mode: number): void {
    this.channel.setArg(0, mode);
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(1, pathLen);
    this.call(OpfsOpcode.MKDIR);
  }

  rmdir(path: string): void {
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    this.call(OpfsOpcode.RMDIR);
  }

  unlink(path: string): void {
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    this.call(OpfsOpcode.UNLINK);
  }

  rename(oldPath: string, newPath: string): void {
    const totalLen = this.channel.writeTwoStrings(oldPath, newPath);
    this.channel.setArg(0, totalLen);
    this.call(OpfsOpcode.RENAME);
  }

  link(_existingPath: string, _newPath: string): void {
    throw new Error("ENOTSUP");
  }

  symlink(_target: string, _path: string): void {
    throw new Error("ENOTSUP");
  }

  readlink(_path: string): string {
    throw new Error("ENOTSUP");
  }

  chmod(_path: string, _mode: number): void {
    // OPFS has no permission model
  }

  chown(_path: string, _uid: number, _gid: number): void {
    // OPFS has no ownership model
  }

  lchown(_path: string, _uid: number, _gid: number): void {
    // OPFS has neither symlinks nor an ownership model, so this has the same
    // existing no-op boundary as chown.
  }

  access(path: string, mode: number): void {
    this.channel.setArg(0, mode);
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(1, pathLen);
    this.call(OpfsOpcode.ACCESS);
  }

  utimensat(_path: string, _atimeSec: number, _atimeNsec: number, _mtimeSec: number, _mtimeNsec: number): void {
    // OPFS doesn't support setting timestamps — no-op
  }

  // --- Directory iteration ---

  opendir(path: string): number {
    const pathLen = this.channel.writeString(path);
    this.channel.setArg(0, pathLen);
    return this.call(OpfsOpcode.OPENDIR);
  }

  readdir(handle: number): DirEntry | null {
    this.channel.setArg(0, handle);
    const rc = this.call(OpfsOpcode.READDIR);
    if (rc === 1) return null; // end of directory
    // Entry data is in data section: name string + type byte
    const nameLen = this.channel.result2;
    const data = this.channel.dataBuffer;
    const name = new TextDecoder().decode(data.subarray(0, nameLen));
    const dtype = data[nameLen];
    return { name, type: dtype, ino: 0 };
  }

  closedir(handle: number): void {
    this.channel.setArg(0, handle);
    this.call(OpfsOpcode.CLOSEDIR);
  }
}
