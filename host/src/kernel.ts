/**
 * WasmPosixKernel — Loads the kernel Wasm module and provides host
 * import functions that bridge Wasm syscalls to the PlatformIO backend.
 *
 * Host import functions exposed to Wasm:
 *   env.host_open(path_ptr, path_len, flags, mode) -> i64
 *   env.host_close(handle: i64) -> i32
 *   env.host_read(handle: i64, buf_ptr, buf_len) -> i32
 *   env.host_write(handle: i64, buf_ptr, buf_len) -> i32
 *   env.host_seek(handle: i64, offset_lo, offset_hi, whence) -> i64
 *   env.host_fstat(handle: i64, stat_ptr) -> i32
 *
 * IMPORTANT: Wasm i64 values appear as BigInt in JavaScript.
 */

import type { KernelConfig, PlatformIO, StatResult } from "./types";
import { SharedPipeBuffer } from "./shared-pipe-buffer";
import { SharedLockTable } from "./shared-lock-table";

/** Size of the WasmStat struct in bytes (repr(C) layout). */
const WASM_STAT_SIZE = 88;

/** Size of the WasmDirent struct: d_ino(u64) + d_type(u32) + d_namlen(u32). */
const WASM_DIRENT_SIZE = 16;

export interface KernelCallbacks {
  onKill?: (pid: number, signal: number) => number;
  onExec?: (path: string) => number;
  onAlarm?: (seconds: number) => number;
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  /** Read up to maxLen bytes from stdin. Return a Uint8Array with available data, or empty/null for EOF. */
  onStdin?: (maxLen: number) => Uint8Array | null;
}

export class WasmPosixKernel {
  private config: KernelConfig;
  private io: PlatformIO;
  private callbacks: KernelCallbacks;
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private sharedPipes = new Map<number, { pipe: SharedPipeBuffer; end: "read" | "write" }>();
  private signalWakeSab: SharedArrayBuffer | null = null;
  private sharedLockTable: SharedLockTable | null = null;
  private programFuncTable: WebAssembly.Table | null = null;

  /**
   * Set the user program's indirect function table so signal handlers
   * registered by the program can be called from the kernel.
   */
  setProgramFuncTable(table: WebAssembly.Table): void {
    this.programFuncTable = table;
  }

  constructor(config: KernelConfig, io: PlatformIO, callbacks?: KernelCallbacks) {
    this.config = config;
    this.io = io;
    this.callbacks = callbacks ?? {};
  }

  registerSharedPipe(handle: number, sab: SharedArrayBuffer, end: "read" | "write"): void {
    this.sharedPipes.set(handle, { pipe: SharedPipeBuffer.fromSharedBuffer(sab), end });
  }

  unregisterSharedPipe(handle: number): void {
    this.sharedPipes.delete(handle);
  }

  /** Returns all registered shared pipes (for transferring during exec). */
  getSharedPipes(): Map<number, { pipe: SharedPipeBuffer; end: "read" | "write" }> {
    return this.sharedPipes;
  }

  registerSignalWakeSab(sab: SharedArrayBuffer): void {
    this.signalWakeSab = sab;
  }

  registerSharedLockTable(sab: SharedArrayBuffer): void {
    this.sharedLockTable = SharedLockTable.fromBuffer(sab);
  }

  /**
   * Load and instantiate the kernel Wasm module.
   *
   * @param wasmBytes - The compiled kernel Wasm binary
   */
  async init(wasmBytes: BufferSource): Promise<void> {
    // The Wasm binary compiled with atomics requires shared memory.
    // The initial/maximum page counts must match the Wasm import declaration
    // (initial=17, max=16384 as emitted by the Rust toolchain).
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: 16384,
      shared: true,
    });
    this.memory = memory;

    const importObject: WebAssembly.Imports = {
      env: {
        memory,
        host_open: (
          pathPtr: number,
          pathLen: number,
          flags: number,
          mode: number,
        ): bigint => {
          return this.hostOpen(pathPtr, pathLen, flags, mode);
        },
        host_close: (handle: bigint): number => {
          return this.hostClose(handle);
        },
        host_read: (
          handle: bigint,
          bufPtr: number,
          bufLen: number,
        ): number => {
          return this.hostRead(handle, bufPtr, bufLen);
        },
        host_write: (
          handle: bigint,
          bufPtr: number,
          bufLen: number,
        ): number => {
          return this.hostWrite(handle, bufPtr, bufLen);
        },
        host_seek: (
          handle: bigint,
          offsetLo: number,
          offsetHi: number,
          whence: number,
        ): bigint => {
          return this.hostSeek(handle, offsetLo, offsetHi, whence);
        },
        host_fstat: (handle: bigint, statPtr: number): number => {
          return this.hostFstat(handle, statPtr);
        },
        host_stat: (
          pathPtr: number,
          pathLen: number,
          statPtr: number,
        ): number => {
          return this.hostStat(pathPtr, pathLen, statPtr);
        },
        host_lstat: (
          pathPtr: number,
          pathLen: number,
          statPtr: number,
        ): number => {
          return this.hostLstat(pathPtr, pathLen, statPtr);
        },
        host_mkdir: (
          pathPtr: number,
          pathLen: number,
          mode: number,
        ): number => {
          return this.hostMkdir(pathPtr, pathLen, mode);
        },
        host_rmdir: (pathPtr: number, pathLen: number): number => {
          return this.hostRmdir(pathPtr, pathLen);
        },
        host_unlink: (pathPtr: number, pathLen: number): number => {
          return this.hostUnlink(pathPtr, pathLen);
        },
        host_rename: (
          oldPtr: number,
          oldLen: number,
          newPtr: number,
          newLen: number,
        ): number => {
          return this.hostRename(oldPtr, oldLen, newPtr, newLen);
        },
        host_link: (
          oldPtr: number,
          oldLen: number,
          newPtr: number,
          newLen: number,
        ): number => {
          return this.hostLink(oldPtr, oldLen, newPtr, newLen);
        },
        host_symlink: (
          targetPtr: number,
          targetLen: number,
          linkPtr: number,
          linkLen: number,
        ): number => {
          return this.hostSymlink(targetPtr, targetLen, linkPtr, linkLen);
        },
        host_readlink: (
          pathPtr: number,
          pathLen: number,
          bufPtr: number,
          bufLen: number,
        ): number => {
          return this.hostReadlink(pathPtr, pathLen, bufPtr, bufLen);
        },
        host_chmod: (
          pathPtr: number,
          pathLen: number,
          mode: number,
        ): number => {
          return this.hostChmod(pathPtr, pathLen, mode);
        },
        host_chown: (
          pathPtr: number,
          pathLen: number,
          uid: number,
          gid: number,
        ): number => {
          return this.hostChown(pathPtr, pathLen, uid, gid);
        },
        host_access: (
          pathPtr: number,
          pathLen: number,
          amode: number,
        ): number => {
          return this.hostAccess(pathPtr, pathLen, amode);
        },
        host_opendir: (pathPtr: number, pathLen: number): bigint => {
          return this.hostOpendir(pathPtr, pathLen);
        },
        host_readdir: (
          dirHandle: bigint,
          direntPtr: number,
          namePtr: number,
          nameLen: number,
        ): number => {
          return this.hostReaddir(dirHandle, direntPtr, namePtr, nameLen);
        },
        host_closedir: (dirHandle: bigint): number => {
          return this.hostClosedir(dirHandle);
        },
        host_clock_gettime: (
          clockId: number,
          secPtr: number,
          nsecPtr: number,
        ): number => {
          return this.hostClockGettime(clockId, secPtr, nsecPtr);
        },
        host_nanosleep: (sec: bigint, nsec: bigint): number => {
          return this.hostNanosleep(sec, nsec);
        },
        host_ftruncate: (handle: bigint, length: bigint): number => {
          return this.hostFtruncate(handle, length);
        },
        host_fsync: (handle: bigint): number => {
          return this.hostFsync(handle);
        },
        host_fchmod: (handle: bigint, mode: number): number => {
          return this.hostFchmod(handle, mode);
        },
        host_fchown: (handle: bigint, uid: number, gid: number): number => {
          return this.hostFchown(handle, uid, gid);
        },
        host_kill: (pid: number, sig: number): number => {
          return this.hostKill(pid, sig);
        },
        host_exec: (pathPtr: number, pathLen: number): number => {
          return this.hostExec(pathPtr, pathLen);
        },
        host_set_alarm: (seconds: number): number => {
          return this.hostSetAlarm(seconds);
        },
        host_sigsuspend_wait: (): number => {
          return this.hostSigsuspendWait();
        },
        host_call_signal_handler: (handler_index: number, signum: number): number => {
          // Signal handlers are registered by the user program, so we must
          // look up the function in the program's table, not the kernel's.
          const table = this.programFuncTable
            ?? (this.instance?.exports.__indirect_function_table as WebAssembly.Table | undefined);
          if (!table) {
            return -22; // EINVAL
          }
          const handler = table.get(handler_index);
          if (handler) {
            try {
              (handler as Function)(signum);
              return 0;
            } catch (e) {
              return -5; // EIO
            }
          }
          return -22; // EINVAL
        },
        host_getrandom: (bufPtr: number, bufLen: number): number => {
          try {
            const mem = this.getMemoryBuffer();
            const target = mem.subarray(bufPtr, bufPtr + bufLen);
            if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
              globalThis.crypto.getRandomValues(target);
            } else {
              // Fallback for environments without Web Crypto
              for (let i = 0; i < bufLen; i++) target[i] = (Math.random() * 256) | 0;
            }
            return bufLen;
          } catch {
            return -5; // EIO
          }
        },
        host_utimensat: (
          pathPtr: number,
          pathLen: number,
          atimeSec: bigint,
          atimeNsec: bigint,
          mtimeSec: bigint,
          mtimeNsec: bigint,
        ): number => {
          return this.hostUtimensat(pathPtr, pathLen, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
        },
        host_waitpid: (
          pid: number,
          options: number,
          statusPtr: number,
        ): number => {
          return this.hostWaitpid(pid, options, statusPtr);
        },
        host_net_connect: (handle: number, addrPtr: number, addrLen: number, port: number): number => {
          return this.hostNetConnect(handle, addrPtr, addrLen, port);
        },
        host_net_send: (handle: number, bufPtr: number, bufLen: number, flags: number): number => {
          return this.hostNetSend(handle, bufPtr, bufLen, flags);
        },
        host_net_recv: (handle: number, bufPtr: number, bufLen: number, flags: number): number => {
          return this.hostNetRecv(handle, bufPtr, bufLen, flags);
        },
        host_net_close: (handle: number): number => {
          return this.hostNetClose(handle);
        },
        host_getaddrinfo: (namePtr: number, nameLen: number, resultPtr: number, resultLen: number): number => {
          return this.hostGetaddrinfo(namePtr, nameLen, resultPtr, resultLen);
        },
        host_fcntl_lock: (
          pathPtr: number, pathLen: number,
          pid: number, cmd: number, lockType: number,
          startLo: number, startHi: number,
          lenLo: number, lenHi: number,
          resultPtr: number,
        ): number => {
          return this.hostFcntlLock(pathPtr, pathLen, pid, cmd, lockType, startLo, startHi, lenLo, lenHi, resultPtr);
        },
      },
    };

    const module = await WebAssembly.compile(
      wasmBytes as BufferSource,
    );
    this.instance = await WebAssembly.instantiate(module, importObject);
  }

  /**
   * Access the Wasm memory (e.g. for tests or advanced use).
   */
  getMemory(): WebAssembly.Memory | null {
    return this.memory;
  }

  /**
   * Access the Wasm instance (e.g. to call exported functions).
   */
  getInstance(): WebAssembly.Instance | null {
    return this.instance;
  }

  // ---- Host import implementations ----

  private getMemoryBuffer(): Uint8Array {
    if (!this.memory) {
      throw new Error("Kernel not initialized");
    }
    return new Uint8Array(this.memory.buffer);
  }

  private getMemoryDataView(): DataView {
    if (!this.memory) {
      throw new Error("Kernel not initialized");
    }
    return new DataView(this.memory.buffer);
  }

  /**
   * host_open(path_ptr, path_len, flags, mode) -> i64
   *
   * Reads the path from Wasm memory and delegates to PlatformIO.
   * For the initial synchronous implementation, we cannot truly await
   * the async PlatformIO.open — so we use a synchronous fallback that
   * blocks on the promise. In practice, NodePlatformIO uses sync fs
   * operations internally, so the promise resolves immediately.
   */
  private hostOpen(
    pathPtr: number,
    pathLen: number,
    flags: number,
    mode: number,
  ): bigint {
    try {
      const mem = this.getMemoryBuffer();
      const pathBytes = mem.slice(pathPtr, pathPtr + pathLen);
      const path = new TextDecoder().decode(pathBytes);
      return BigInt(this.io.open(path, flags, mode));
    } catch {
      return BigInt(-1);
    }
  }

  /**
   * host_close(handle: i64) -> i32
   */
  private hostClose(handle: bigint): number {
    const h = Number(handle);

    // Check shared pipe registry
    const entry = this.sharedPipes.get(h);
    if (entry) {
      if (entry.end === "read") {
        entry.pipe.closeRead();
      } else {
        entry.pipe.closeWrite();
      }
      this.sharedPipes.delete(h);
      return 0;
    }

    // Handles 0, 1, 2 are pre-opened stdio (stdin, stdout, stderr).
    // These map to the host process's real fds and must NOT be closed
    // by the guest — doing so would close the host's own stdio streams
    // and can cause hangs (e.g., Node.js blocking on fs.closeSync(2)
    // when called from within a Wasm host import callback with shared memory).
    if (h >= 0 && h <= 2) {
      return 0;
    }

    try {
      return this.io.close(h);
    } catch {
      return -1;
    }
  }

  /**
   * host_read(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handle 0 (stdin): return 0 (no stdin support yet).
   * Other handles: delegate to PlatformIO.
   */
  private hostRead(handle: bigint, bufPtr: number, bufLen: number): number {
    const h = Number(handle);

    // Check shared pipe registry
    const readEntry = this.sharedPipes.get(h);
    if (readEntry) {
      const mem = this.getMemoryBuffer();
      const dst = new Uint8Array(mem.buffer, bufPtr, bufLen);
      return readEntry.pipe.read(dst);
    }

    // stdin
    if (h === 0) {
      if (this.callbacks.onStdin) {
        const data = this.callbacks.onStdin(bufLen);
        if (!data || data.length === 0) return 0; // EOF
        const mem = this.getMemoryBuffer();
        const n = Math.min(data.length, bufLen);
        mem.set(data.subarray(0, n), bufPtr);
        return n;
      }
      return 0; // EOF when no stdin callback
    }

    try {
      const mem = this.getMemoryBuffer();
      const buf = mem.subarray(bufPtr, bufPtr + bufLen);
      return this.io.read(h, buf, null, bufLen);
    } catch {
      return -1;
    }
  }

  /**
   * host_write(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handles 1 (stdout) and 2 (stderr): uses callback if provided,
   * falls back to process.stdout/stderr (Node.js), then console (browser).
   * Other handles: delegate to PlatformIO.
   */
  private hostWrite(handle: bigint, bufPtr: number, bufLen: number): number {
    const h = Number(handle);
    const mem = this.getMemoryBuffer();
    const data = mem.slice(bufPtr, bufPtr + bufLen);

    // Check shared pipe registry
    const writeEntry = this.sharedPipes.get(h);
    if (writeEntry) {
      return writeEntry.pipe.write(data);
    }

    // stdout / stderr — callback → process → console fallback chain
    if (h === 1) {
      if (this.callbacks.onStdout) {
        this.callbacks.onStdout(data);
      } else if (typeof process !== "undefined" && process.stdout) {
        process.stdout.write(data);
      } else {
        console.log(new TextDecoder().decode(data));
      }
      return bufLen;
    }
    if (h === 2) {
      if (this.callbacks.onStderr) {
        this.callbacks.onStderr(data);
      } else if (typeof process !== "undefined" && process.stderr) {
        process.stderr.write(data);
      } else {
        console.error(new TextDecoder().decode(data));
      }
      return bufLen;
    }

    try {
      return this.io.write(h, data, null, bufLen);
    } catch {
      return -1;
    }
  }

  /**
   * host_seek(handle: i64, offset_lo, offset_hi, whence) -> i64
   *
   * Combines the low and high 32-bit parts into a 64-bit offset.
   */
  private hostSeek(
    handle: bigint,
    offsetLo: number,
    offsetHi: number,
    whence: number,
  ): bigint {
    const h = Number(handle);
    // Reconstruct 64-bit signed offset from two 32-bit parts.
    // JS bitwise operators are 32-bit, so we use multiplication for the high word.
    const offset = offsetHi * 0x100000000 + (offsetLo >>> 0);

    try {
      return BigInt(this.io.seek(h, offset, whence));
    } catch {
      return BigInt(-1);
    }
  }

  /**
   * host_fstat(handle: i64, stat_ptr) -> i32
   *
   * Writes a WasmStat structure into Wasm memory at stat_ptr.
   *
   * WasmStat layout (repr(C), 88 bytes total):
   *   0:  st_dev        u64
   *   8:  st_ino        u64
   *   16: st_mode       u32
   *   20: st_nlink      u32
   *   24: st_uid        u32
   *   28: st_gid        u32
   *   32: st_size       u64
   *   40: st_atime_sec  u64
   *   48: st_atime_nsec u32
   *   52: (pad)         u32
   *   56: st_mtime_sec  u64
   *   64: st_mtime_nsec u32
   *   68: (pad)         u32
   *   72: st_ctime_sec  u64
   *   80: st_ctime_nsec u32
   *   84: _pad          u32
   */
  private hostFstat(handle: bigint, statPtr: number): number {
    const h = Number(handle);

    try {
      const stat = this.io.fstat(h);
      this.writeStatToMemory(statPtr, stat);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * Write a StatResult into the WasmStat struct at the given Wasm memory offset.
   */
  private writeStatToMemory(ptr: number, stat: StatResult): void {
    const dv = this.getMemoryDataView();

    // Zero out the struct first (handles padding bytes).
    const mem = this.getMemoryBuffer();
    mem.fill(0, ptr, ptr + WASM_STAT_SIZE);

    dv.setBigUint64(ptr + 0, BigInt(stat.dev), true); // st_dev
    dv.setBigUint64(ptr + 8, BigInt(stat.ino), true); // st_ino
    dv.setUint32(ptr + 16, stat.mode, true); // st_mode
    dv.setUint32(ptr + 20, stat.nlink, true); // st_nlink
    dv.setUint32(ptr + 24, stat.uid, true); // st_uid
    dv.setUint32(ptr + 28, stat.gid, true); // st_gid
    dv.setBigUint64(ptr + 32, BigInt(stat.size), true); // st_size

    // Convert millisecond timestamps to seconds + nanoseconds.
    const atimeSec = Math.floor(stat.atimeMs / 1000);
    const atimeNsec = Math.floor((stat.atimeMs % 1000) * 1_000_000);
    dv.setBigUint64(ptr + 40, BigInt(atimeSec), true); // st_atime_sec
    dv.setUint32(ptr + 48, atimeNsec, true); // st_atime_nsec

    const mtimeSec = Math.floor(stat.mtimeMs / 1000);
    const mtimeNsec = Math.floor((stat.mtimeMs % 1000) * 1_000_000);
    dv.setBigUint64(ptr + 56, BigInt(mtimeSec), true); // st_mtime_sec
    dv.setUint32(ptr + 64, mtimeNsec, true); // st_mtime_nsec

    const ctimeSec = Math.floor(stat.ctimeMs / 1000);
    const ctimeNsec = Math.floor((stat.ctimeMs % 1000) * 1_000_000);
    dv.setBigUint64(ptr + 72, BigInt(ctimeSec), true); // st_ctime_sec
    dv.setUint32(ptr + 80, ctimeNsec, true); // st_ctime_nsec
    // _pad at offset 84 already zeroed
  }

  // ---- Phase 2: Path-based and directory host imports ----

  /**
   * Read a UTF-8 path string from Wasm memory.
   */
  private readPathFromMemory(ptr: number, len: number): string {
    const mem = this.getMemoryBuffer();
    const pathBytes = mem.slice(ptr, ptr + len);
    return new TextDecoder().decode(pathBytes);
  }

  /**
   * host_stat(path_ptr, path_len, stat_ptr) -> i32
   */
  private hostStat(
    pathPtr: number,
    pathLen: number,
    statPtr: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.stat(path);
      this.writeStatToMemory(statPtr, stat);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_lstat(path_ptr, path_len, stat_ptr) -> i32
   */
  private hostLstat(
    pathPtr: number,
    pathLen: number,
    statPtr: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.lstat(path);
      this.writeStatToMemory(statPtr, stat);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_mkdir(path_ptr, path_len, mode) -> i32
   */
  private hostMkdir(
    pathPtr: number,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.mkdir(path, mode);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_rmdir(path_ptr, path_len) -> i32
   */
  private hostRmdir(pathPtr: number, pathLen: number): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.rmdir(path);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_unlink(path_ptr, path_len) -> i32
   */
  private hostUnlink(pathPtr: number, pathLen: number): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.unlink(path);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_rename(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  private hostRename(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
  ): number {
    try {
      const oldPath = this.readPathFromMemory(oldPtr, oldLen);
      const newPath = this.readPathFromMemory(newPtr, newLen);
      this.io.rename(oldPath, newPath);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_link(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  private hostLink(
    oldPtr: number,
    oldLen: number,
    newPtr: number,
    newLen: number,
  ): number {
    try {
      const existingPath = this.readPathFromMemory(oldPtr, oldLen);
      const newPath = this.readPathFromMemory(newPtr, newLen);
      this.io.link(existingPath, newPath);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_symlink(target_ptr, target_len, link_ptr, link_len) -> i32
   */
  private hostSymlink(
    targetPtr: number,
    targetLen: number,
    linkPtr: number,
    linkLen: number,
  ): number {
    try {
      const target = this.readPathFromMemory(targetPtr, targetLen);
      const linkPath = this.readPathFromMemory(linkPtr, linkLen);
      this.io.symlink(target, linkPath);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_readlink(path_ptr, path_len, buf_ptr, buf_len) -> i32
   *
   * Returns the number of bytes written to the buffer, or -1 on error.
   */
  private hostReadlink(
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
    bufLen: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const target = this.io.readlink(path);
      const encoded = new TextEncoder().encode(target);
      const n = Math.min(encoded.length, bufLen);
      const mem = this.getMemoryBuffer();
      mem.set(encoded.subarray(0, n), bufPtr);
      return n;
    } catch {
      return -1;
    }
  }

  /**
   * host_chmod(path_ptr, path_len, mode) -> i32
   */
  private hostChmod(
    pathPtr: number,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.chmod(path, mode);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_chown(path_ptr, path_len, uid, gid) -> i32
   */
  private hostChown(
    pathPtr: number,
    pathLen: number,
    uid: number,
    gid: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.chown(path, uid, gid);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_access(path_ptr, path_len, amode) -> i32
   */
  private hostAccess(
    pathPtr: number,
    pathLen: number,
    amode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.access(path, amode);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_utimensat(path_ptr, path_len, atime_sec, atime_nsec, mtime_sec, mtime_nsec) -> i32
   */
  private hostUtimensat(
    pathPtr: number,
    pathLen: number,
    atimeSec: bigint,
    atimeNsec: bigint,
    mtimeSec: bigint,
    mtimeNsec: bigint,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.utimensat(path, Number(atimeSec), Number(atimeNsec), Number(mtimeSec), Number(mtimeNsec));
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_waitpid(pid, options, status_ptr) -> i32
   * Returns child pid on success, negative errno on error.
   * Writes wait status to status_ptr.
   */
  private hostWaitpid(
    pid: number,
    options: number,
    statusPtr: number,
  ): number {
    if (!this.io.waitpid) {
      return -10; // -ECHILD
    }
    try {
      const result = this.io.waitpid(pid, options);
      if (statusPtr !== 0 && this.memory) {
        const view = new DataView(this.memory.buffer);
        view.setInt32(statusPtr, result.status, true);
      }
      return result.pid;
    } catch {
      return -10; // -ECHILD
    }
  }

  /**
   * host_opendir(path_ptr, path_len) -> i64
   *
   * Returns a directory handle as i64, or -1 on error.
   */
  private hostOpendir(pathPtr: number, pathLen: number): bigint {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      return BigInt(this.io.opendir(path));
    } catch {
      return BigInt(-1);
    }
  }

  /**
   * host_readdir(dir_handle: i64, dirent_ptr, name_ptr, name_len) -> i32
   *
   * Writes a WasmDirent struct and the entry name to Wasm memory.
   * Returns 1 if an entry was written, 0 at end-of-directory, -1 on error.
   */
  private hostReaddir(
    dirHandle: bigint,
    direntPtr: number,
    namePtr: number,
    nameLen: number,
  ): number {
    try {
      const h = Number(dirHandle);
      const dirEntry = this.io.readdir(h);
      if (dirEntry === null) return 0; // end of directory

      const dv = this.getMemoryDataView();
      const mem = this.getMemoryBuffer();

      // Write WasmDirent: d_ino(u64) + d_type(u32) + d_namlen(u32)
      const encoded = new TextEncoder().encode(dirEntry.name);
      const n = Math.min(encoded.length, nameLen);

      dv.setBigUint64(direntPtr, BigInt(dirEntry.ino), true);
      dv.setUint32(direntPtr + 8, dirEntry.type, true);
      dv.setUint32(direntPtr + 12, n, true);

      // Write name
      mem.set(encoded.subarray(0, n), namePtr);

      return 1;
    } catch {
      return -1;
    }
  }

  /**
   * host_closedir(dir_handle: i64) -> i32
   */
  private hostClosedir(dirHandle: bigint): number {
    try {
      const h = Number(dirHandle);
      this.io.closedir(h);
      return 0;
    } catch {
      return -1;
    }
  }

  // ---- Phase 7: Time host imports ----

  /**
   * host_clock_gettime(clock_id, sec_ptr, nsec_ptr) -> i32
   *
   * Writes the current time (seconds and nanoseconds) to Wasm memory
   * at the given pointers.
   */
  private hostClockGettime(
    clockId: number,
    secPtr: number,
    nsecPtr: number,
  ): number {
    try {
      const result = this.io.clockGettime(clockId);
      const dv = this.getMemoryDataView();
      dv.setBigInt64(secPtr, BigInt(result.sec), true);
      dv.setBigInt64(nsecPtr, BigInt(result.nsec), true);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_nanosleep(sec: i64, nsec: i64) -> i32
   *
   * Sleep for the specified duration. The i64 parameters appear as
   * BigInt in JavaScript.
   */
  private hostNanosleep(sec: bigint, nsec: bigint): number {
    try {
      this.io.nanosleep(Number(sec), Number(nsec));
      return 0;
    } catch {
      return -1;
    }
  }

  // ---- Phase 11: ftruncate/fsync/fchmod/fchown host imports ----

  private hostFtruncate(handle: bigint, length: bigint): number {
    try {
      this.io.ftruncate(Number(handle), Number(length));
      return 0;
    } catch {
      return -1;
    }
  }

  private hostFsync(handle: bigint): number {
    try {
      this.io.fsync(Number(handle));
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_fchmod(handle: i64, mode: u32) -> i32
   */
  private hostFchmod(handle: bigint, mode: number): number {
    try {
      this.io.fchmod(Number(handle), mode);
      return 0;
    } catch {
      return -1;
    }
  }

  /**
   * host_fchown(handle: i64, uid: u32, gid: u32) -> i32
   */
  private hostFchown(handle: bigint, uid: number, gid: number): number {
    try {
      this.io.fchown(Number(handle), uid, gid);
      return 0;
    } catch {
      return -1;
    }
  }

  // ---- Phase 13d: Cross-process kill ----

  private hostKill(pid: number, sig: number): number {
    if (this.callbacks.onKill) {
      return this.callbacks.onKill(pid, sig);
    }
    return -3; // -ESRCH: no callback means can't reach other processes
  }

  // ---- Phase 13e: Exec ----

  private hostExec(pathPtr: number, pathLen: number): number {
    if (this.callbacks.onExec) {
      const mem = this.getMemoryBuffer();
      const path = new TextDecoder().decode(mem.slice(pathPtr, pathPtr + pathLen));
      return this.callbacks.onExec(path);
    }
    return -2; // -ENOENT
  }

  // ---- Phase 14: Alarm ----

  private hostSetAlarm(seconds: number): number {
    if (this.callbacks.onAlarm) {
      return this.callbacks.onAlarm(seconds);
    }
    return 0;
  }

  private hostSigsuspendWait(): number {
    if (!this.signalWakeSab) {
      return -(4); // -EINTR, no SAB available
    }
    const view = new Int32Array(this.signalWakeSab);

    // Check if already signaled (race-safe via CAS)
    const old = Atomics.compareExchange(view, 0, 1, 0);
    if (old === 1) {
      const sig = Atomics.load(view, 1);
      Atomics.store(view, 1, 0);
      return sig;
    }

    // Block until notified
    Atomics.wait(view, 0, 0);

    // Read signal and reset
    const sig = Atomics.load(view, 1);
    Atomics.store(view, 0, 0);
    Atomics.store(view, 1, 0);
    return sig;
  }

  // ---- Public API: Socket & Poll operations ----

  /**
   * Create a socket. Returns the fd or throws on error.
   */
  socket(domain: number, type: number, protocol: number): number {
    const fn = this.instance!.exports.kernel_socket as (
      domain: number,
      type: number,
      protocol: number,
    ) => number;
    const result = fn(domain, type, protocol);
    if (result < 0) throw new Error(`socket failed: errno ${-result}`);
    return result;
  }

  /**
   * Create a connected pair of Unix domain stream sockets.
   * Returns [fd0, fd1].
   */
  socketpair(domain: number, type: number, protocol: number): [number, number] {
    const fn = this.instance!.exports.kernel_socketpair as (
      domain: number,
      type: number,
      protocol: number,
      svPtr: number,
    ) => number;
    // Use a scratch area in Wasm memory for the two i32 results.
    // We use offset 0 of the data buffer (safe for temp use since no
    // concurrent host operations touch it).
    const dv = this.getMemoryDataView();
    const scratchPtr = 4; // offset 4 to avoid address 0
    const result = fn(domain, type, protocol, scratchPtr);
    if (result < 0) throw new Error(`socketpair failed: errno ${-result}`);
    const fd0 = dv.getInt32(scratchPtr, true);
    const fd1 = dv.getInt32(scratchPtr + 4, true);
    return [fd0, fd1];
  }

  /**
   * Shut down part of a full-duplex socket connection.
   */
  shutdown(fd: number, how: number): void {
    const fn = this.instance!.exports.kernel_shutdown as (
      fd: number,
      how: number,
    ) => number;
    const result = fn(fd, how);
    if (result < 0) throw new Error(`shutdown failed: errno ${-result}`);
  }

  /**
   * Send data on a connected socket. Returns bytes sent.
   */
  send(fd: number, data: Uint8Array, flags: number = 0): number {
    const fn = this.instance!.exports.kernel_send as (
      fd: number,
      bufPtr: number,
      bufLen: number,
      flags: number,
    ) => number;
    // Write data into Wasm memory at a temp location
    const mem = this.getMemoryBuffer();
    const tmpPtr = 16; // scratch area
    mem.set(data, tmpPtr);
    const result = fn(fd, tmpPtr, data.length, flags);
    if (result < 0) throw new Error(`send failed: errno ${-result}`);
    return result;
  }

  /**
   * Receive data from a connected socket. Returns the received data.
   */
  recv(fd: number, maxLen: number, flags: number = 0): Uint8Array {
    const fn = this.instance!.exports.kernel_recv as (
      fd: number,
      bufPtr: number,
      bufLen: number,
      flags: number,
    ) => number;
    const tmpPtr = 16; // scratch area
    const result = fn(fd, tmpPtr, maxLen, flags);
    if (result < 0) throw new Error(`recv failed: errno ${-result}`);
    const mem = this.getMemoryBuffer();
    return mem.slice(tmpPtr, tmpPtr + result);
  }

  /**
   * Poll file descriptors for I/O readiness.
   * Returns array of {fd, events, revents} with revents filled in.
   */
  poll(
    fds: Array<{ fd: number; events: number }>,
    timeout: number,
  ): Array<{ fd: number; events: number; revents: number }> {
    const fn = this.instance!.exports.kernel_poll as (
      fdsPtr: number,
      nfds: number,
      timeout: number,
    ) => number;
    const nfds = fds.length;
    const tmpPtr = 16; // scratch area
    const dv = this.getMemoryDataView();
    // Write pollfd structs (8 bytes each: i32 fd, i16 events, i16 revents)
    for (let i = 0; i < nfds; i++) {
      const off = tmpPtr + i * 8;
      dv.setInt32(off, fds[i].fd, true);
      dv.setInt16(off + 4, fds[i].events, true);
      dv.setInt16(off + 6, 0, true);
    }
    const result = fn(tmpPtr, nfds, timeout);
    if (result < 0) throw new Error(`poll failed: errno ${-result}`);
    return fds.map((f, i) => ({
      fd: f.fd,
      events: f.events,
      revents: dv.getInt16(tmpPtr + i * 8 + 6, true),
    }));
  }

  /**
   * Get a socket option value.
   */
  getsockopt(fd: number, level: number, optname: number): number {
    const fn = this.instance!.exports.kernel_getsockopt as (
      fd: number,
      level: number,
      optname: number,
      optvalPtr: number,
    ) => number;
    const dv = this.getMemoryDataView();
    const scratchPtr = 4;
    const result = fn(fd, level, optname, scratchPtr);
    if (result < 0) throw new Error(`getsockopt failed: errno ${-result}`);
    return dv.getUint32(scratchPtr, true);
  }

  /**
   * Set a socket option value.
   */
  setsockopt(fd: number, level: number, optname: number, value: number): void {
    const fn = this.instance!.exports.kernel_setsockopt as (
      fd: number,
      level: number,
      optname: number,
      optval: number,
    ) => number;
    const result = fn(fd, level, optname, value);
    if (result < 0) throw new Error(`setsockopt failed: errno ${-result}`);
  }

  // ---- Public API: Terminal operations ----

  /**
   * Get terminal attributes (48 bytes: c_iflag, c_oflag, c_cflag, c_lflag + c_cc).
   */
  tcgetattr(fd: number): Uint8Array {
    const fn = this.instance!.exports.kernel_tcgetattr as (
      fd: number,
      bufPtr: number,
      bufLen: number,
    ) => number;
    const tmpPtr = 16;
    const result = fn(fd, tmpPtr, 48);
    if (result < 0) throw new Error(`tcgetattr failed: errno ${-result}`);
    const mem = this.getMemoryBuffer();
    return mem.slice(tmpPtr, tmpPtr + 48);
  }

  /**
   * Set terminal attributes.
   * action: 0=TCSANOW, 1=TCSADRAIN, 2=TCSAFLUSH
   */
  tcsetattr(fd: number, action: number, attrs: Uint8Array): void {
    const fn = this.instance!.exports.kernel_tcsetattr as (
      fd: number,
      action: number,
      bufPtr: number,
      bufLen: number,
    ) => number;
    const mem = this.getMemoryBuffer();
    const tmpPtr = 16;
    mem.set(attrs, tmpPtr);
    const result = fn(fd, action, tmpPtr, attrs.length);
    if (result < 0) throw new Error(`tcsetattr failed: errno ${-result}`);
  }

  /**
   * Perform an ioctl operation.
   * For TIOCGWINSZ (0x5413): returns 8-byte buffer (ws_row, ws_col, ws_xpixel, ws_ypixel as u16 LE)
   * For TIOCSWINSZ (0x5414): pass 8-byte buffer to set window size
   */
  ioctl(fd: number, request: number, buf?: Uint8Array): Uint8Array {
    const fn = this.instance!.exports.kernel_ioctl as (
      fd: number,
      request: number,
      bufPtr: number,
      bufLen: number,
    ) => number;
    const mem = this.getMemoryBuffer();
    const tmpPtr = 16;
    const bufLen = buf ? buf.length : 8;
    if (buf) mem.set(buf, tmpPtr);
    const result = fn(fd, request, tmpPtr, bufLen);
    if (result < 0) throw new Error(`ioctl failed: errno ${-result}`);
    return mem.slice(tmpPtr, tmpPtr + bufLen);
  }

  /**
   * Set signal handler (legacy API). Returns previous handler value.
   * handler: 0=SIG_DFL, 1=SIG_IGN, or function pointer index
   */
  signal(signum: number, handler: number): number {
    const fn = this.instance!.exports.kernel_signal as (
      signum: number,
      handler: number,
    ) => number;
    const result = fn(signum, handler);
    if (result < 0) throw new Error(`signal failed: errno ${-result}`);
    return result;
  }

  // ---- Public API: Phase 10 Extended POSIX ----

  /**
   * Set file creation mask. Returns previous mask.
   */
  umask(mask: number): number {
    const fn = this.instance!.exports.kernel_umask as (mask: number) => number;
    return fn(mask);
  }

  /**
   * Get system identification. Returns object with sysname, nodename, release, version, machine.
   */
  uname(): { sysname: string; nodename: string; release: string; version: string; machine: string } {
    const fn = this.instance!.exports.kernel_uname as (bufPtr: number, bufLen: number) => number;
    const tmpPtr = 16;
    const result = fn(tmpPtr, 325);
    if (result < 0) throw new Error(`uname failed: errno ${-result}`);
    const mem = this.getMemoryBuffer();
    const decoder = new TextDecoder();
    const readField = (offset: number): string => {
      const start = tmpPtr + offset;
      let end = start;
      while (end < start + 65 && mem[end] !== 0) end++;
      return decoder.decode(mem.slice(start, end));
    };
    return {
      sysname: readField(0),
      nodename: readField(65),
      release: readField(130),
      version: readField(195),
      machine: readField(260),
    };
  }

  /**
   * Get configurable system variable value.
   */
  sysconf(name: number): number {
    const fn = this.instance!.exports.kernel_sysconf as (name: number) => bigint;
    const result = fn(name);
    return Number(result);
  }

  /**
   * Duplicate fd with flags. Unlike dup2, returns error if oldfd == newfd.
   */
  dup3(oldfd: number, newfd: number, flags: number): number {
    const fn = this.instance!.exports.kernel_dup3 as (
      oldfd: number, newfd: number, flags: number
    ) => number;
    const result = fn(oldfd, newfd, flags);
    if (result < 0) throw new Error(`dup3 failed: errno ${-result}`);
    return result;
  }

  /**
   * Create pipe with flags (O_NONBLOCK, O_CLOEXEC). Returns [readFd, writeFd].
   */
  pipe2(flags: number): [number, number] {
    const fn = this.instance!.exports.kernel_pipe2 as (
      flags: number, fdPtr: number
    ) => number;
    const dv = this.getMemoryDataView();
    const scratchPtr = 4;
    const result = fn(flags, scratchPtr);
    if (result < 0) throw new Error(`pipe2 failed: errno ${-result}`);
    return [dv.getInt32(scratchPtr, true), dv.getInt32(scratchPtr + 4, true)];
  }

  /**
   * Truncate file to specified length.
   */
  ftruncate(fd: number, length: number): void {
    const fn = this.instance!.exports.kernel_ftruncate as (
      fd: number, lengthLo: number, lengthHi: number
    ) => number;
    const lo = length & 0xFFFFFFFF;
    const hi = Math.floor(length / 0x100000000);
    const result = fn(fd, lo, hi);
    if (result < 0) throw new Error(`ftruncate failed: errno ${-result}`);
  }

  /**
   * Synchronize file state to storage.
   */
  fsync(fd: number): void {
    const fn = this.instance!.exports.kernel_fsync as (fd: number) => number;
    const result = fn(fd);
    if (result < 0) throw new Error(`fsync failed: errno ${-result}`);
  }

  // ---- Public API: Phase 11 Final Gaps ----

  /**
   * Truncate a file by path to specified length.
   */
  truncate(pathPtr: number, pathLen: number, length: number): void {
    const fn = this.instance!.exports.kernel_truncate as (
      pathPtr: number, pathLen: number, lengthLo: number, lengthHi: number
    ) => number;
    const lo = length & 0xFFFFFFFF;
    const hi = Math.floor(length / 0x100000000);
    const result = fn(pathPtr, pathLen, lo, hi);
    if (result < 0) throw new Error(`truncate failed: errno ${-result}`);
  }

  /**
   * Synchronize file data to storage (alias for fsync in Wasm).
   */
  fdatasync(fd: number): void {
    const fn = this.instance!.exports.kernel_fdatasync as (fd: number) => number;
    const result = fn(fd);
    if (result < 0) throw new Error(`fdatasync failed: errno ${-result}`);
  }

  /**
   * Change file mode via fd.
   */
  fchmod(fd: number, mode: number): void {
    const fn = this.instance!.exports.kernel_fchmod as (fd: number, mode: number) => number;
    const result = fn(fd, mode);
    if (result < 0) throw new Error(`fchmod failed: errno ${-result}`);
  }

  /**
   * Change file owner/group via fd.
   */
  fchown(fd: number, uid: number, gid: number): void {
    const fn = this.instance!.exports.kernel_fchown as (
      fd: number, uid: number, gid: number
    ) => number;
    const result = fn(fd, uid, gid);
    if (result < 0) throw new Error(`fchown failed: errno ${-result}`);
  }

  /**
   * Get process group ID.
   */
  getpgrp(): number {
    const fn = this.instance!.exports.kernel_getpgrp as () => number;
    return fn();
  }

  /**
   * Set process group ID.
   */
  setpgid(pid: number, pgid: number): void {
    const fn = this.instance!.exports.kernel_setpgid as (
      pid: number, pgid: number
    ) => number;
    const result = fn(pid, pgid);
    if (result < 0) throw new Error(`setpgid failed: errno ${-result}`);
  }

  /**
   * Get session ID.
   */
  getsid(pid: number): number {
    const fn = this.instance!.exports.kernel_getsid as (pid: number) => number;
    const result = fn(pid);
    if (result < 0) throw new Error(`getsid failed: errno ${-result}`);
    return result;
  }

  /**
   * Create new session.
   */
  setsid(): number {
    const fn = this.instance!.exports.kernel_setsid as () => number;
    const result = fn();
    if (result < 0) throw new Error(`setsid failed: errno ${-result}`);
    return result;
  }

  // ---- Public API: Phase 12 Remaining Tractable ----

  /**
   * Set real and effective user ID.
   */
  setuid(uid: number): void {
    const fn = this.instance!.exports.kernel_setuid as (uid: number) => number;
    const result = fn(uid);
    if (result < 0) throw new Error(`setuid failed: errno ${-result}`);
  }

  /**
   * Set real and effective group ID.
   */
  setgid(gid: number): void {
    const fn = this.instance!.exports.kernel_setgid as (gid: number) => number;
    const result = fn(gid);
    if (result < 0) throw new Error(`setgid failed: errno ${-result}`);
  }

  /**
   * Set effective user ID.
   */
  seteuid(euid: number): void {
    const fn = this.instance!.exports.kernel_seteuid as (euid: number) => number;
    const result = fn(euid);
    if (result < 0) throw new Error(`seteuid failed: errno ${-result}`);
  }

  /**
   * Set effective group ID.
   */
  setegid(egid: number): void {
    const fn = this.instance!.exports.kernel_setegid as (egid: number) => number;
    const result = fn(egid);
    if (result < 0) throw new Error(`setegid failed: errno ${-result}`);
  }

  /**
   * Get resource usage. Returns 144-byte rusage struct.
   */
  getrusage(who: number): Uint8Array {
    const fn = this.instance!.exports.kernel_getrusage as (
      who: number, bufPtr: number, bufLen: number
    ) => number;
    const tmpPtr = 16;
    const result = fn(who, tmpPtr, 144);
    if (result < 0) throw new Error(`getrusage failed: errno ${-result}`);
    const mem = this.getMemoryBuffer();
    return mem.slice(tmpPtr, tmpPtr + 144);
  }

  /**
   * select() — synchronous I/O multiplexing.
   * Takes fd arrays for read/write/except monitoring, returns arrays of ready fds.
   */
  select(
    nfds: number,
    readfds: number[] | null,
    writefds: number[] | null,
    exceptfds: number[] | null,
  ): { readReady: number[]; writeReady: number[]; exceptReady: number[] } {
    const fn = this.instance!.exports.kernel_select as (
      nfds: number, readPtr: number, writePtr: number, exceptPtr: number, timeout: number
    ) => number;

    const mem = this.getMemoryBuffer();
    // Allocate 3 fd_sets in Wasm memory (128 bytes each = 384 total)
    const basePtr = 16;
    const readPtr = readfds ? basePtr : 0;
    const writePtr = writefds ? basePtr + 128 : 0;
    const exceptPtr = exceptfds ? basePtr + 256 : 0;

    // Initialize fd_sets
    if (readfds) {
      mem.fill(0, readPtr, readPtr + 128);
      for (const fd of readfds) {
        mem[readPtr + Math.floor(fd / 8)] |= 1 << (fd % 8);
      }
    }
    if (writefds) {
      mem.fill(0, writePtr, writePtr + 128);
      for (const fd of writefds) {
        mem[writePtr + Math.floor(fd / 8)] |= 1 << (fd % 8);
      }
    }
    if (exceptfds) {
      mem.fill(0, exceptPtr, exceptPtr + 128);
      for (const fd of exceptfds) {
        mem[exceptPtr + Math.floor(fd / 8)] |= 1 << (fd % 8);
      }
    }

    const result = fn(nfds, readPtr, writePtr, exceptPtr, 0);
    if (result < 0) throw new Error(`select failed: errno ${-result}`);

    // Extract results
    const extractReady = (ptr: number, fds: number[] | null): number[] => {
      if (!fds || !ptr) return [];
      return fds.filter(fd => (mem[ptr + Math.floor(fd / 8)] >> (fd % 8)) & 1);
    };

    return {
      readReady: extractReady(readPtr, readfds),
      writeReady: extractReady(writePtr, writefds),
      exceptReady: extractReady(exceptPtr, exceptfds),
    };
  }

  // ---- Networking host imports ----

  private hostNetConnect(handle: number, addrPtr: number, addrLen: number, port: number): number {
    if (!this.io.network) return -111; // -ECONNREFUSED
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const addr = mem.slice(addrPtr, addrPtr + addrLen);
      this.io.network.connect(handle, addr, port);
      return 0;
    } catch {
      return -111; // -ECONNREFUSED
    }
  }

  private hostNetSend(handle: number, bufPtr: number, bufLen: number, flags: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const data = mem.slice(bufPtr, bufPtr + bufLen);
      return this.io.network.send(handle, data, flags);
    } catch {
      return -32; // -EPIPE
    }
  }

  private hostNetRecv(handle: number, bufPtr: number, bufLen: number, flags: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      const data = this.io.network.recv(handle, bufLen, flags);
      if (data.length > 0 && this.memory) {
        const mem = new Uint8Array(this.memory.buffer);
        mem.set(data, bufPtr);
      }
      return data.length;
    } catch {
      return -104; // -ECONNRESET
    }
  }

  private hostNetClose(handle: number): number {
    if (!this.io.network) return 0;
    try {
      this.io.network.close(handle);
      return 0;
    } catch {
      return 0;
    }
  }

  private hostGetaddrinfo(namePtr: number, nameLen: number, resultPtr: number, resultLen: number): number {
    if (!this.io.network) return -2; // -ENOENT
    try {
      const mem = new Uint8Array(this.memory!.buffer);
      const name = new TextDecoder().decode(mem.slice(namePtr, namePtr + nameLen));
      const addr = this.io.network.getaddrinfo(name);
      if (addr.length > resultLen) return -22; // -EINVAL
      mem.set(addr, resultPtr);
      return addr.length;
    } catch {
      return -2; // -ENOENT
    }
  }

  // fcntl lock constants (must match crates/shared/src/lib.rs)
  private static readonly F_GETLK = 12;
  private static readonly F_SETLK = 13;
  private static readonly F_SETLKW = 14;
  private static readonly F_UNLCK = 2;

  private hostFcntlLock(
    pathPtr: number, pathLen: number,
    pid: number, cmd: number, lockType: number,
    startLo: number, startHi: number,
    lenLo: number, lenHi: number,
    resultPtr: number,
  ): number {
    if (!this.sharedLockTable) {
      // No shared lock table — fall through (kernel handles locally)
      return 0;
    }
    try {
      const mem = this.getMemoryBuffer();
      const path = new TextDecoder().decode(mem.slice(pathPtr, pathPtr + pathLen));
      const pathHash = SharedLockTable.hashPath(path);
      const start = (BigInt(startHi) << 32n) | BigInt(startLo >>> 0);
      const len = (BigInt(lenHi) << 32n) | BigInt(lenLo >>> 0);

      switch (cmd) {
        case WasmPosixKernel.F_GETLK: {
          const blocker = this.sharedLockTable.getBlockingLock(pathHash, lockType, start, len, pid);
          const dv = this.getMemoryDataView();
          if (blocker) {
            dv.setUint32(resultPtr, blocker.lockType, true);
            dv.setUint32(resultPtr + 4, blocker.pid, true);
            const bStart = blocker.start;
            dv.setUint32(resultPtr + 8, Number(bStart & 0xffffffffn), true);
            dv.setUint32(resultPtr + 12, Number((bStart >> 32n) & 0xffffffffn), true);
            const bLen = blocker.len;
            dv.setUint32(resultPtr + 16, Number(bLen & 0xffffffffn), true);
            dv.setUint32(resultPtr + 20, Number((bLen >> 32n) & 0xffffffffn), true);
          } else {
            // No conflict — write F_UNLCK
            dv.setUint32(resultPtr, WasmPosixKernel.F_UNLCK, true);
          }
          return 0;
        }
        case WasmPosixKernel.F_SETLK: {
          const ok = this.sharedLockTable.setLock(pathHash, pid, lockType, start, len);
          return ok ? 0 : -11; // -EAGAIN
        }
        case WasmPosixKernel.F_SETLKW: {
          this.sharedLockTable.setLockWait(pathHash, pid, lockType, start, len);
          return 0;
        }
        default:
          return -22; // -EINVAL
      }
    } catch {
      return -5; // -EIO
    }
  }
}
