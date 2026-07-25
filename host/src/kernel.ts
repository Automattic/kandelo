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
 *   env.host_statfs(path_ptr, path_len, statfs_ptr) -> i32
 *
 * IMPORTANT: Wasm i64 values appear as BigInt in JavaScript.
 */

import type { KernelConfig, PlatformIO, StatResult, StatfsResult } from "./types";
import { SharedPipeBuffer } from "./shared-pipe-buffer";
import { FramebufferRegistry } from "./framebuffer/registry";
import { GbmBoRegistry } from "./dri/registry";
import { KmsRegistry } from "./dri/kms-registry";
import { GlContextRegistry } from "./webgl/registry";
import { decodeAndDispatch, validateCommandBuffer } from "./webgl/bridge";
import { runGlQuery } from "./webgl/query";
import { SubmitQueue } from "./webgl/submit-queue";
import { GlMuxer } from "./webgl/muxer";
import { drainSubmitQueue } from "./webgl/submit-drain";
import {
  IOCTL_REQUESTS,
  STRUCT_SIZE_WASM_DIRENT,
  STRUCT_SIZE_WASM_STAT,
  STRUCT_SIZE_WASM_STATFS,
  STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
} from "./generated/abi";
import { detectPtrWidth } from "./constants";
import {
  allocateKernelScratchRegion,
  checkedWasmImportMemoryRange,
  checkedWasmPointer,
  intrinsicUint8ArrayView,
  KernelScratchError,
  type KernelScratchRegion,
} from "./kernel-scratch";

export type KernelPointer = number | bigint;

const MAX_U64 = (1n << 64n) - 1n;
const intrinsicApply = Reflect.apply;
const intrinsicArrayBufferIsView = ArrayBuffer.isView;
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const intrinsicDataViewBuffer = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)!.get!;
const intrinsicDataViewByteOffset = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteOffset",
)!.get!;
const intrinsicDataViewByteLength = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;
const intrinsicTypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
);
const intrinsicTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "buffer",
)!.get!;
const intrinsicTypedArrayByteOffset = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteOffset",
)!.get!;
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  "byteLength",
)!.get!;
const IntrinsicUint8Array = Uint8Array;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;

interface IntrinsicBufferSourceSpan {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}

function exactU64(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= MAX_U64) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  const error = new Error(
    `EOVERFLOW: ${field} is not exactly representable as an unsigned 64-bit value`,
  ) as Error & { code: string };
  error.code = "EOVERFLOW";
  throw error;
}

function intrinsicBufferSourceSpan(
  source: BufferSource,
): IntrinsicBufferSourceSpan {
  try {
    if (!intrinsicArrayBufferIsView(source)) {
      return {
        buffer: source,
        byteOffset: 0,
        byteLength: intrinsicApply(
          intrinsicArrayBufferByteLength,
          source,
          [],
        ) as number,
      };
    }

    try {
      return {
        buffer: intrinsicApply(
          intrinsicDataViewBuffer,
          source,
          [],
        ) as ArrayBufferLike,
        byteOffset: intrinsicApply(
          intrinsicDataViewByteOffset,
          source,
          [],
        ) as number,
        byteLength: intrinsicApply(
          intrinsicDataViewByteLength,
          source,
          [],
        ) as number,
      };
    } catch {
      return {
        buffer: intrinsicApply(
          intrinsicTypedArrayBuffer,
          source,
          [],
        ) as ArrayBufferLike,
        byteOffset: intrinsicApply(
          intrinsicTypedArrayByteOffset,
          source,
          [],
        ) as number,
        byteLength: intrinsicApply(
          intrinsicTypedArrayByteLength,
          source,
          [],
        ) as number,
      };
    }
  } catch {
    throw new TypeError(
      "kernel WebAssembly bytes must be an attached, genuine BufferSource",
    );
  }
}

function bufferSourceToArrayBuffer(source: BufferSource): ArrayBuffer {
  const span = intrinsicBufferSourceSpan(source);
  let exactView: Uint8Array;
  try {
    exactView = new IntrinsicUint8Array(
      span.buffer,
      span.byteOffset,
      span.byteLength,
    );
  } catch {
    throw new TypeError(
      "kernel WebAssembly bytes must be an attached, genuine BufferSource",
    );
  }

  const snapshot = new IntrinsicUint8Array(span.byteLength);
  intrinsicApply(intrinsicUint8ArraySet, snapshot, [exactView]);
  return intrinsicApply(
    intrinsicTypedArrayBuffer,
    snapshot,
    [],
  ) as ArrayBuffer;
}

const DEFAULT_KMS_MODE_WIDTH = 1920;
const DEFAULT_KMS_MODE_HEIGHT = 1080;
const DEFAULT_KMS_REFRESH_HZ = 60;

function kmsModeInfoBytes(
  width?: number,
  height?: number,
  refreshHz = DEFAULT_KMS_REFRESH_HZ,
): Uint8Array {
  const w = clampModeDim(width, DEFAULT_KMS_MODE_WIDTH);
  const h = clampModeDim(height, DEFAULT_KMS_MODE_HEIGHT);
  const hsyncStart = clampU16(w + 16);
  const hsyncEnd = clampU16(w + 48);
  const htotal = clampU16(w + 160);
  const vsyncStart = clampU16(h + 3);
  const vsyncEnd = clampU16(h + 8);
  const vtotal = clampU16(h + 45);
  const clock = Math.max(1, Math.min(0xffffffff, Math.round(htotal * vtotal * refreshHz / 1000)));
  const out = new Uint8Array(STRUCT_SIZE_WPK_DRM_MODE_MODEINFO);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, clock, true);
  dv.setUint16(4, w, true);
  dv.setUint16(6, hsyncStart, true);
  dv.setUint16(8, hsyncEnd, true);
  dv.setUint16(10, htotal, true);
  dv.setUint16(12, 0, true);
  dv.setUint16(14, h, true);
  dv.setUint16(16, vsyncStart, true);
  dv.setUint16(18, vsyncEnd, true);
  dv.setUint16(20, vtotal, true);
  dv.setUint16(22, 0, true);
  dv.setUint32(24, refreshHz, true);
  dv.setUint32(28, 0, true);
  // DRM_MODE_TYPE_DRIVER | DRM_MODE_TYPE_PREFERRED
  dv.setUint32(32, 0x1 | 0x8, true);
  const name = `${w}x${h}`;
  for (let i = 0; i < Math.min(name.length, 31); i++) {
    out[36 + i] = name.charCodeAt(i) & 0xff;
  }
  return out;
}

function clampModeDim(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return clampU16(Math.trunc(value));
}

function clampU16(value: number): number {
  return Math.max(1, Math.min(0xffff, Math.trunc(value)));
}

/**
 * Map filesystem error codes to negative errno values.
 * Handles both Node.js-style string codes ("ENOENT") and
 * numeric codes from SFSError (2, 17, etc.).
 * Returns -EIO for unknown errors.
 */
const NEG_ERRNO_BY_NAME: Readonly<Record<string, number>> = {
  EPERM: -1,
  ENOENT: -2,
  ESRCH: -3,
  EINTR: -4,
  EIO: -5,
  ENXIO: -6,
  E2BIG: -7,
  ENOEXEC: -8,
  EBADF: -9,
  ECHILD: -10,
  EAGAIN: -11,
  EWOULDBLOCK: -11,
  ENOMEM: -12,
  EACCES: -13,
  EFAULT: -14,
  EBUSY: -16,
  EEXIST: -17,
  EXDEV: -18,
  ENODEV: -19,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENFILE: -23,
  EMFILE: -24,
  ENOTTY: -25,
  ETXTBSY: -26,
  EFBIG: -27,
  ENOSPC: -28,
  ESPIPE: -29,
  EROFS: -30,
  EMLINK: -31,
  EPIPE: -32,
  ERANGE: -34,
  EDEADLK: -35,
  ENAMETOOLONG: -36,
  ENOSYS: -38,
  ENOTEMPTY: -39,
  ELOOP: -40,
  ENOMSG: -42,
  EIDRM: -43,
  ENODATA: -61,
  EOVERFLOW: -75,
  ENOTSOCK: -88,
  EDESTADDRREQ: -89,
  EMSGSIZE: -90,
  EPROTOTYPE: -91,
  ENOPROTOOPT: -92,
  EPROTONOSUPPORT: -93,
  EOPNOTSUPP: -95,
  ENOTSUP: -95,
  EAFNOSUPPORT: -97,
  EADDRINUSE: -98,
  EADDRNOTAVAIL: -99,
  ENETUNREACH: -101,
  ECONNABORTED: -103,
  ECONNRESET: -104,
  EISCONN: -106,
  ENOTCONN: -107,
  ESHUTDOWN: -108,
  ETIMEDOUT: -110,
  ECONNREFUSED: -111,
  EALREADY: -114,
  EINPROGRESS: -115,
};

export function negErrno(err: unknown): number {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string | number }).code;
    // Numeric errno (e.g. SFSError from MemoryFileSystem/SharedFS)
    // SharedFS uses negative codes (-2 for ENOENT, -17 for EEXIST, etc.)
    if (typeof code === "number" && code !== 0) {
      return code < 0 ? code : -code;
    }
    if (typeof code === "string") {
      const mapped = NEG_ERRNO_BY_NAME[code];
      if (mapped !== undefined) return mapped;
    }
  }
  if (err && typeof err === "object" && "errno" in err) {
    const errno = (err as { errno: unknown }).errno;
    if (typeof errno === "number" && Number.isInteger(errno) && errno !== 0) {
      return errno < 0 ? errno : -errno;
    }
  }
  // Check error message for errno names (e.g. plain Error("ENOENT") from DeviceFS)
  if (err instanceof Error) {
    const name = /^([A-Z][A-Z0-9_]*)\b/.exec(err.message)?.[1];
    if (name !== undefined) {
      const mapped = NEG_ERRNO_BY_NAME[name];
      if (mapped !== undefined) return mapped;
    }
  }
  return -5; // EIO
}

/** Size of the WasmStat struct in bytes (repr(C) layout). */
const WASM_STAT_SIZE = STRUCT_SIZE_WASM_STAT;

/** Size of the WasmStatfs struct in bytes (repr(C) layout). */
const WASM_STATFS_SIZE = STRUCT_SIZE_WASM_STATFS;

/** Size of the WasmDirent struct: d_ino(u64) + d_type(u32) + d_namlen(u32). */
const WASM_DIRENT_SIZE = STRUCT_SIZE_WASM_DIRENT;

export interface KernelCallbacks {
  onExec?: (path: string) => number;
  onAlarm?: (seconds: number) => number;
  onPosixTimer?: (timerId: number, signo: number, valueMs: number, intervalMs: number) => number;
  onWaitpid?: (targetPid: number, options: number) => void;
  onNetListen?: (fd: number, port: number, addr: [number, number, number, number]) => number;
  onUdpBind?: (handle: number, addr: [number, number, number, number], port: number) => number;
  onUdpUnbind?: (handle: number) => number;
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
  /** Read up to maxLen bytes from stdin. Return a Uint8Array with available data, or empty/null for EOF. */
  onStdin?: (maxLen: number) => Uint8Array | null;
  /**
   * Resolve the wasm `Memory` for `pid`. The GL bridge reads cmdbuf bytes
   * directly out of the process's Memory SAB on `host_gl_submit` and
   * `host_gl_query`, so the embedder must thread its per-pid memory map
   * through this callback. Returning `undefined` is interpreted as "the
   * process is gone" and turns the GL call into a silent no-op.
   */
  getProcessMemory?: (pid: number) => WebAssembly.Memory | undefined;
  /**
   * Resolve the KMS scanout canvas for `crtcId`, if one is registered.
   * Used by `host_gl_create_context` to auto-attach the canvas to the
   * DRM-master pid's GL binding so user programs that drive the modeset
   * stack (drmModeSetCrtc + eglCreateContext) don't have to call
   * `gl.attachCanvas` separately. Returning `undefined` keeps the
   * legacy "embedder must call attachCanvas manually" path alive.
   */
  getKmsCanvas?: (crtcId: number) => OffscreenCanvas | HTMLCanvasElement | undefined;
  /**
   * Notify the embedder that GL has claimed the canvas for `crtcId`.
   * The KMS vblank pump uses this to skip the CPU `putImageData` blit
   * for canvases now painted directly by WebGL2. Idempotent.
   */
  markKmsCanvasGlOwned?: (crtcId: number) => void;
}

export class WasmPosixKernel {
  private config: KernelConfig;
  private io: PlatformIO;
  private callbacks: KernelCallbacks;
  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private kernelPtrWidth: 4 | 8 = 4;
  private sharedPipes = new Map<number, { pipe: SharedPipeBuffer; end: "read" | "write" }>();
  private signalWakeSab: SharedArrayBuffer | null = null;
  private programFuncTable: WebAssembly.Table | null = null;
  private waitpidSab: SharedArrayBuffer | null = null;
  /**
   * A backend directory iterator may already have advanced before the host
   * bridge discovers that it cannot marshal the returned entry into Wasm
   * memory. Keep that entry here until every output write succeeds so the
   * guest can retry without losing it.
   */
  private pendingDirectoryEntries = new Map<
    number,
    { name: string; type: number; ino: number }
  >();
  /**
   * Extra host-handle ownership held by regular-file MAP_SHARED backings.
   * The Rust kernel emits host_close only after the last guest descriptor is
   * gone; a mapping retain defers that physical close until its backing is
   * also released.
   */
  private retainedHostFileHandles = new Map<
    number,
    { mappingRefs: number; descriptorClosePending: boolean }
  >();
  /** Active synchronous host_fstat capture used by mmap preflight. */
  private fstatHandleCapture: { handle: number | null } | null = null;
  isThreadWorker = false;
  /**
   * Live `/dev/fb0` mappings the kernel has reported via
   * `host_bind_framebuffer`. Renderers (canvas in browser, no-op in
   * Node) read this on each frame.
   */
  readonly framebuffers = new FramebufferRegistry();
  /**
   * Live GBM buffer objects on `/dev/dri/renderD128` reported by the
   * kernel via `host_gbm_bo_*`. Pixel storage for the v1 CpuShared
   * tier lives in the process's wasm Memory at the bind range;
   * consumers read pixels by projecting that range onto the process
   * Memory SAB (same model as the mmap-based framebuffer binding).
   */
  readonly bos = new GbmBoRegistry();
  readonly kms = new KmsRegistry(this.bos);
  /**
   * Live `/dev/dri/renderD128` GLES sessions. The kernel reports
   * binds/unbinds via `host_gl_*`; the bridge in `webgl/bridge.ts`
   * decodes the cmdbuf TLV stream against a per-pid `WebGL2RenderingContext`
   * once the embedder has attached a canvas.
   */
  readonly gl = new GlContextRegistry();
  /**
   * Worker-side submit lanes. The compositor (current DRM_MASTER on
   * card0) jumps ahead of clients; clients round-robin. Drain runs
   * synchronously inside `host_gl_submit` because the C process is
   * blocked on that syscall — deferring would race the SAB cmdbuf.
   *
   * Muxers keyed by `WebGL2RenderingContext` so pids sharing a canvas
   * share a muxer; `WeakMap` drops the muxer when the context is GC'd.
   */
  private gl_submit_queue = new SubmitQueue((pid) => this.kms.isMasterPid(pid));
  private gl_muxers = new WeakMap<WebGL2RenderingContext, GlMuxer>();

  /**
   * Merge additional callbacks into the existing set.
   * Existing callbacks not specified in the argument are preserved.
   */
  mergeCallbacks(callbacks: Partial<KernelCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

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
    // Let the GBM bo registry reach per-pid wasm Memory so the
    // bind/unbind sync (parent writes → SAB → child reads after PRIME
    // export+import) actually moves bytes. The closure follows
    // `mergeCallbacks` because it reads `this.callbacks` at call time.
    this.bos.setProcessMemoryResolver((pid) =>
      this.callbacks.getProcessMemory?.(pid),
    );
  }

  getKernelPtrWidth(): 4 | 8 {
    return this.kernelPtrWidth;
  }

  toKernelPtr(value: number | bigint): KernelPointer {
    const numberValue = checkedWasmPointer(
      value,
      this.kernelPtrWidth,
      "kernel export pointer",
    );
    return this.kernelPtrWidth === 8 ? BigInt(numberValue) : numberValue;
  }

  /**
   * Losslessly convert one kernel `usize` value for a host API that stores an
   * address, offset, or length as a JavaScript number.
   *
   * WHY: `Number(bigint)` silently rounds above MAX_SAFE_INTEGER and bitwise
   * operators silently discard every bit above bit 31. Device metadata is not
   * scratch, but it still must not alias a different process-memory range.
   */
  private checkedKernelIndex(value: KernelPointer, field: string): number {
    return checkedWasmPointer(value, this.kernelPtrWidth, field);
  }

  private checkedKernelSpan(
    offsetValue: KernelPointer,
    lengthValue: KernelPointer,
    limit: number,
    field: string,
  ): { offset: number; length: number; end: number } {
    const offset = this.checkedKernelIndex(offsetValue, `${field} offset`);
    const length = this.checkedKernelIndex(lengthValue, `${field} length`);
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new KernelScratchError(`${field} has an invalid capacity`);
    }
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end < offset || end > limit) {
      throw new KernelScratchError(`${field} exceeds its declared capacity`);
    }
    return { offset, length, end };
  }

  /**
   * Capture the concrete host handle used by one synchronous kernel fstat.
   * This lets MAP_SHARED retain the open-file capability itself instead of
   * reopening a remembered pathname that may already have been unlinked.
   */
  withFstatHandleCapture<T>(operation: () => T): {
    result: T;
    handle: number | null;
  } {
    if (this.fstatHandleCapture) {
      throw new Error("nested host fstat handle capture");
    }
    const capture = { handle: null as number | null };
    this.fstatHandleCapture = capture;
    try {
      return { result: operation(), handle: capture.handle };
    } finally {
      this.fstatHandleCapture = null;
    }
  }

  /** Retain one mapping-owned reference to an existing host file handle. */
  retainHostFileHandle(handle: number): void {
    if (!Number.isSafeInteger(handle) || handle < 0) {
      throw new Error(`invalid host file handle ${handle}`);
    }
    const retained = this.retainedHostFileHandles.get(handle);
    if (retained) {
      if (retained.descriptorClosePending) {
        throw new Error(`cannot retain closed host file handle ${handle}`);
      }
      retained.mappingRefs++;
      return;
    }
    this.retainedHostFileHandles.set(handle, {
      mappingRefs: 1,
      descriptorClosePending: false,
    });
  }

  /**
   * Release one mapping-owned reference. If the guest descriptor lifetime
   * ended first, this performs the deferred physical backend close.
   */
  releaseHostFileHandle(handle: number): number {
    const retained = this.retainedHostFileHandles.get(handle);
    if (!retained || retained.mappingRefs <= 0) return -9; // EBADF
    retained.mappingRefs--;
    if (retained.mappingRefs > 0) return 0;
    this.retainedHostFileHandles.delete(handle);
    if (!retained.descriptorClosePending) return 0;
    try {
      return this.io.close(handle);
    } catch (e) {
      return negErrno(e);
    }
  }

  private createKernelMemory(): WebAssembly.Memory {
    if (this.kernelPtrWidth === 8) {
      return new WebAssembly.Memory({
        initial: 24n,
        maximum: 16384n,
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor);
    }
    return new WebAssembly.Memory({
      // 24 pages = 1.5 MiB of initial address space. This must remain above
      // the kernel Wasm's linker-derived minimum and leaves headroom for
      // future static data without re-tuning host construction each time.
      initial: 24,
      maximum: 16384,
      shared: true,
    });
  }

  /**
   * Push one PS/2 mouse packet into the kernel's `/dev/input/mice`
   * queue. Silently dropped if the kernel module hasn't been
   * instantiated yet — a canvas can fire `mousemove` before the program
   * registers the device. `dy` is in PS/2 sense (positive-up); the
   * caller must invert browser deltaY before calling.
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void {
    const inject = this.instance?.exports?.kernel_inject_mouse_event as
      | ((dx: number, dy: number, buttons: number) => void)
      | undefined;
    if (!inject) return;
    inject(dx, dy, buttons);
  }

  // ---------------------------------------------------------------------------
  // /dev/dsp — host-drained PCM audio
  // ---------------------------------------------------------------------------

  /**
   * Lazily-allocated kernel-memory scratch region for audio drains. We
   * allocate on first use so the kernel module doesn't reserve audio
   * memory in processes that never play sound. ~64 KiB is comfortably
   * larger than any single drain call would ask for.
   */
  private audioScratchRegion: KernelScratchRegion | null = null;
  private static readonly AUDIO_SCRATCH_SIZE = 65536;
  private apiScratchRegion: KernelScratchRegion | null = null;
  private static readonly API_SCRATCH_SIZE = 65536;

  private requireApiScratch(): KernelScratchRegion {
    if (this.apiScratchRegion) return this.apiScratchRegion;
    if (!this.memory) {
      throw new Error("kernel memory is not initialized");
    }
    const allocator = this.instance?.exports.kernel_alloc_scratch as
      | ((size: number) => KernelPointer)
      | undefined;
    if (!allocator) {
      throw new Error("kernel is missing its scratch allocator");
    }
    this.apiScratchRegion = allocateKernelScratchRegion(
      this.memory,
      allocator,
      WasmPosixKernel.API_SCRATCH_SIZE,
      this.kernelPtrWidth,
      "kernel public API scratch",
    );
    return this.apiScratchRegion;
  }

  private ensureAudioScratch(): boolean {
    if (this.audioScratchRegion) return true;
    if (!this.memory) return false;
    const exports = this.instance?.exports as Record<string, unknown> | undefined;
    const alloc = exports?.kernel_alloc_scratch as
      | ((size: number) => bigint | number)
      | undefined;
    if (!alloc) return false;
    try {
      this.audioScratchRegion = allocateKernelScratchRegion(
        this.memory,
        alloc,
        WasmPosixKernel.AUDIO_SCRATCH_SIZE,
        this.kernelPtrWidth,
        "kernel audio scratch",
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drain up to `out.byteLength` bytes of PCM audio buffered in
   * `/dev/dsp` into the host-provided buffer. Returns the number of
   * bytes copied. Reads stop at whole-frame boundaries so the host
   * never receives a torn L/R pair.
   *
   * Returns 0 if the kernel hasn't been instantiated, no scratch
   * buffer can be allocated, or the ring is empty — the caller doesn't
   * have to special-case any of those.
   */
  drainAudio(out: Uint8Array): number {
    const exports = this.instance?.exports as Record<string, unknown> | undefined;
    const drain = exports?.kernel_drain_audio as
      | ((ptr: KernelPointer, len: number) => number)
      | undefined;
    if (!drain || !this.memory || !this.ensureAudioScratch()) return 0;
    // Cap the request at our scratch size. Typical drain rates
    // (~22 ms of stereo S16 @ 44.1 kHz = ~7.7 KiB per call) are well
    // under the cap; callers needing more invoke drainAudio in a loop.
    const region = this.audioScratchRegion!;
    const want = Math.min(out.byteLength, region.capacity);
    return region.withLease((scratch) => {
      const n = drain(
        this.toKernelPtr(scratch.address(0, want)),
        want,
      );
      if (!Number.isSafeInteger(n) || n < 0 || n > want) return 0;
      if (n > 0) scratch.copyTo(out, 0, 0, n);
      return n;
    });
  }

  /**
   * Currently-configured `/dev/dsp` sample rate (Hz). 0 if the kernel
   * isn't instantiated yet.
   */
  audioSampleRate(): number {
    const exports = this.instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_sample_rate as (() => number) | undefined;
    return fn ? fn() : 0;
  }

  /**
   * Currently-configured `/dev/dsp` channel count (1 = mono, 2 = stereo).
   * 0 if the kernel isn't instantiated yet.
   */
  audioChannels(): number {
    const exports = this.instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_channels as (() => number) | undefined;
    return fn ? fn() : 0;
  }

  /**
   * Bytes currently buffered in the `/dev/dsp` ring. Lets the host
   * estimate how much audio is queued ahead of the AudioContext clock.
   */
  audioPending(): number {
    const exports = this.instance?.exports as Record<string, unknown> | undefined;
    const fn = exports?.kernel_audio_pending as (() => number) | undefined;
    return fn ? fn() : 0;
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

  registerWaitpidSab(sab: SharedArrayBuffer): void {
    this.waitpidSab = sab;
  }

  /**
   * Load and instantiate the kernel Wasm module.
   *
   * @param wasmBytes - The compiled kernel Wasm binary
   */
  async init(wasmBytes: BufferSource): Promise<void> {
    // WHY: view subclasses can spoof public span getters. Pointer-width
    // parsing and engine compilation must consume one identical immutable
    // snapshot or imports can normalize every pointer for the wrong Wasm ABI.
    const wasmSnapshot = bufferSourceToArrayBuffer(wasmBytes);
    this.kernelPtrWidth = detectPtrWidth(wasmSnapshot);
    const memory = this.createKernelMemory();
    this.memory = memory;
    const importObject = this.buildImportObject(memory);
    const module = await WebAssembly.compile(wasmSnapshot);
    this.instance = await WebAssembly.instantiate(module, importObject);
  }

  /**
   * Like init(), but uses an existing shared WebAssembly.Memory instead of
   * creating a new one. Used by thread workers that share the parent's memory.
   */
  async initWithMemory(wasmBytes: BufferSource, memory: WebAssembly.Memory): Promise<void> {
    // Keep the width parser and compiler on the same detached byte identity;
    // this also prevents the caller from replacing bytes between both steps.
    const wasmSnapshot = bufferSourceToArrayBuffer(wasmBytes);
    this.kernelPtrWidth = detectPtrWidth(wasmSnapshot);
    this.memory = memory;
    const importObject = this.buildImportObject(memory);
    const module = await WebAssembly.compile(wasmSnapshot);
    this.instance = await WebAssembly.instantiate(module, importObject);
  }

  private buildImportObject(memory: WebAssembly.Memory): WebAssembly.Imports {
    return {
      env: {
        memory,
        host_debug_log: (ptr: KernelPointer, len: number): void => {
          const msg = new TextDecoder().decode(
            this.readKernelBytes(ptr, len),
          );
          console.log(`[KERNEL] ${msg}`);
        },
        host_open: (pathPtr: KernelPointer, pathLen: number, flags: number, mode: number): bigint => {
          return this.hostOpen(pathPtr, pathLen, flags, mode);
        },
        host_close: (handle: bigint): number => {
          return this.hostClose(handle);
        },
        host_read: (handle: bigint, bufPtr: KernelPointer, bufLen: number): number => {
          return this.hostRead(handle, bufPtr, bufLen);
        },
        host_write: (handle: bigint, bufPtr: KernelPointer, bufLen: number): number => {
          return this.hostWrite(handle, bufPtr, bufLen);
        },
        host_seek: (handle: bigint, offsetLo: number, offsetHi: number, whence: number): bigint => {
          return this.hostSeek(handle, offsetLo, offsetHi, whence);
        },
        host_fstat: (handle: bigint, statPtr: KernelPointer): number => {
          return this.hostFstat(handle, statPtr);
        },
        host_stat: (pathPtr: KernelPointer, pathLen: number, statPtr: KernelPointer): number => {
          return this.hostStat(pathPtr, pathLen, statPtr);
        },
        host_lstat: (pathPtr: KernelPointer, pathLen: number, statPtr: KernelPointer): number => {
          return this.hostLstat(pathPtr, pathLen, statPtr);
        },
        host_statfs: (pathPtr: KernelPointer, pathLen: number, statfsPtr: KernelPointer): number => {
          return this.hostStatfs(pathPtr, pathLen, statfsPtr);
        },
        host_pathconf: (pathPtr: KernelPointer, pathLen: number, name: number, valuePtr: KernelPointer): number => {
          return this.hostPathconf(pathPtr, pathLen, name, valuePtr);
        },
        host_fpathconf: (handle: bigint, name: number, valuePtr: KernelPointer): number => {
          return this.hostFpathconf(handle, name, valuePtr);
        },
        host_mkdir: (pathPtr: KernelPointer, pathLen: number, mode: number): number => {
          return this.hostMkdir(pathPtr, pathLen, mode);
        },
        host_rmdir: (pathPtr: KernelPointer, pathLen: number): number => {
          return this.hostRmdir(pathPtr, pathLen);
        },
        host_unlink: (pathPtr: KernelPointer, pathLen: number): number => {
          return this.hostUnlink(pathPtr, pathLen);
        },
        host_rename: (oldPtr: KernelPointer, oldLen: number, newPtr: KernelPointer, newLen: number): number => {
          return this.hostRename(oldPtr, oldLen, newPtr, newLen);
        },
        host_link: (oldPtr: KernelPointer, oldLen: number, newPtr: KernelPointer, newLen: number): number => {
          return this.hostLink(oldPtr, oldLen, newPtr, newLen);
        },
        host_symlink: (targetPtr: KernelPointer, targetLen: number, linkPtr: KernelPointer, linkLen: number): number => {
          return this.hostSymlink(targetPtr, targetLen, linkPtr, linkLen);
        },
        host_readlink: (pathPtr: KernelPointer, pathLen: number, bufPtr: KernelPointer, bufLen: number): number => {
          return this.hostReadlink(pathPtr, pathLen, bufPtr, bufLen);
        },
        host_chmod: (pathPtr: KernelPointer, pathLen: number, mode: number): number => {
          return this.hostChmod(pathPtr, pathLen, mode);
        },
        host_chown: (pathPtr: KernelPointer, pathLen: number, uid: number, gid: number): number => {
          return this.hostChown(pathPtr, pathLen, uid, gid);
        },
        host_lchown: (pathPtr: KernelPointer, pathLen: number, uid: number, gid: number): number => {
          return this.hostLchown(pathPtr, pathLen, uid, gid);
        },
        host_access: (pathPtr: KernelPointer, pathLen: number, amode: number): number => {
          return this.hostAccess(pathPtr, pathLen, amode);
        },
        host_opendir: (pathPtr: KernelPointer, pathLen: number): bigint => {
          return this.hostOpendir(pathPtr, pathLen);
        },
        host_readdir: (dirHandle: bigint, direntPtr: KernelPointer, namePtr: KernelPointer, nameLen: number): number => {
          return this.hostReaddir(dirHandle, direntPtr, namePtr, nameLen);
        },
        host_closedir: (dirHandle: bigint): number => {
          return this.hostClosedir(dirHandle);
        },
        host_clock_gettime: (clockId: number, secPtr: KernelPointer, nsecPtr: KernelPointer): number => {
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
        host_exec: (pathPtr: KernelPointer, pathLen: number): number => {
          return this.hostExec(pathPtr, pathLen);
        },
        host_set_alarm: (seconds: number): number => {
          return this.hostSetAlarm(seconds);
        },
        host_set_posix_timer: (timerId: number, signo: number, valueMsLo: number, valueMsHi: number, intervalMsLo: number, intervalMsHi: number): number => {
          const valueMs = (valueMsHi >>> 0) * 0x100000000 + (valueMsLo >>> 0);
          const intervalMs = (intervalMsHi >>> 0) * 0x100000000 + (intervalMsLo >>> 0);
          return this.hostSetPosixTimer(timerId, signo, valueMs, intervalMs);
        },
        host_sigsuspend_wait: (): number => {
          return this.hostSigsuspendWait();
        },
        host_call_signal_handler: (handler_index: number, signum: number, sa_flags: number): number => {
          const SA_SIGINFO = 4;
          const table = this.programFuncTable
            ?? (this.instance?.exports.__indirect_function_table as WebAssembly.Table | undefined);
          if (!table) {
            return -22; // EINVAL
          }
          const handler = table.get(handler_index);
          if (handler) {
            try {
              if (sa_flags & SA_SIGINFO) {
                // SA_SIGINFO: call handler(signum, siginfo_ptr, ucontext_ptr)
                // siginfo_ptr=0 and ucontext_ptr=0 for now (no siginfo written to memory yet)
                (handler as Function)(signum, 0, 0);
              } else {
                (handler as Function)(signum);
              }
              return 0;
            } catch (e) {
              return -5; // EIO
            }
          }
          return -22; // EINVAL
        },
        host_getrandom: (bufPtr: KernelPointer, bufLen: number): number => {
          try {
            const destination = checkedWasmImportMemoryRange(
              memory,
              bufPtr,
              bufLen,
              this.kernelPtrWidth,
              "host_getrandom destination",
            );
            const random = new Uint8Array(destination.length);
            if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
              // crypto.getRandomValues rejects SharedArrayBuffer-backed views
              // in browsers. The owned temporary also ensures no host callback
              // retains a live view of kernel memory.
              globalThis.crypto.getRandomValues(random);
            } else {
              for (let i = 0; i < bufLen; i++) {
                random[i] = (Math.random() * 256) | 0;
              }
            }
            this.writeKernelBytes(bufPtr, bufLen, random);
            return bufLen;
          } catch (error) {
            return negErrno(error);
          }
        },
        host_utimensat: (
          pathPtr: KernelPointer, pathLen: number,
          atimeSec: bigint, atimeNsec: bigint, mtimeSec: bigint, mtimeNsec: bigint,
        ): number => {
          return this.hostUtimensat(pathPtr, pathLen, atimeSec, atimeNsec, mtimeSec, mtimeNsec);
        },
        host_waitpid: (pid: number, options: number, statusPtr: KernelPointer): number => {
          return this.hostWaitpid(pid, options, statusPtr);
        },
        host_net_connect: (handle: number, addrPtr: KernelPointer, addrLen: number, port: number): number => {
          return this.hostNetConnect(handle, addrPtr, addrLen, port);
        },
        host_net_send: (handle: number, bufPtr: KernelPointer, bufLen: number, flags: number): number => {
          return this.hostNetSend(handle, bufPtr, bufLen, flags);
        },
        host_net_recv: (handle: number, bufPtr: KernelPointer, bufLen: number, flags: number): number => {
          return this.hostNetRecv(handle, bufPtr, bufLen, flags);
        },
        host_net_poll: (handle: number, events: number): number => {
          return this.hostNetPoll(handle, events);
        },
        host_net_connect_status: (handle: number): number => {
          return this.hostNetConnectStatus(handle);
        },
        host_net_close: (handle: number): number => {
          return this.hostNetClose(handle);
        },
        host_net_listen: (fd: number, port: number, addrA: number, addrB: number, addrC: number, addrD: number): number => {
          return this.hostNetListen(fd, port, addrA, addrB, addrC, addrD);
        },
        host_udp_bind: (handle: number, addrA: number, addrB: number, addrC: number, addrD: number, port: number): number => {
          return this.hostUdpBind(handle, addrA, addrB, addrC, addrD, port);
        },
        host_udp_unbind: (handle: number): number => {
          return this.hostUdpUnbind(handle);
        },
        host_udp_send: (
          srcA: number, srcB: number, srcC: number, srcD: number, srcPort: number,
          dstA: number, dstB: number, dstC: number, dstD: number, dstPort: number,
          dataPtr: KernelPointer, dataLen: number,
        ): number => {
          return this.hostUdpSend(
            srcA, srcB, srcC, srcD, srcPort,
            dstA, dstB, dstC, dstD, dstPort,
            dataPtr, dataLen,
          );
        },
        host_getaddrinfo: (namePtr: KernelPointer, nameLen: number, resultPtr: KernelPointer, resultLen: number): number => {
          return this.hostGetaddrinfo(namePtr, nameLen, resultPtr, resultLen);
        },
        host_futex_wait: (addr: KernelPointer, expected: number, timeoutLo: number, timeoutHi: number): number => {
          return this.hostFutexWait(addr, expected, timeoutLo, timeoutHi);
        },
        host_futex_wake: (addr: KernelPointer, count: number): number => {
          return this.hostFutexWake(addr, count);
        },
        host_is_thread_worker: (): number => {
          return this.isThreadWorker ? 1 : 0;
        },
        // /dev/fb0 hooks: the kernel notifies the host when a process
        // maps or unmaps the framebuffer. The registry is purely
        // metadata; whether anything renders is the consuming app's
        // choice (canvas in browser, no-op in Node tests).
        host_bind_framebuffer: (
          pid: number, addr: KernelPointer, len: KernelPointer,
          w: number, h: number, stride: number, fmt: number,
        ): void => {
          const binding = this.checkedKernelSpan(
            addr,
            len,
            Number.MAX_SAFE_INTEGER,
            "host_bind_framebuffer process range",
          );
          this.framebuffers.bind({
            pid,
            addr: binding.offset,
            len: binding.length,
            w,
            h,
            stride,
            // Only BGRA32 is defined today (fmt=0). If we ever add
            // formats we'll branch on the tag here.
            fmt: fmt === 0 ? "BGRA32" : "BGRA32",
          });
        },
        host_unbind_framebuffer: (pid: number): void => {
          this.framebuffers.unbind(pid);
        },
        host_fb_write: (
          pid: number,
          offset: KernelPointer,
          srcPtr: KernelPointer,
          len: KernelPointer,
        ): void => {
          this.framebuffers.fbWrite(
            pid,
            this.checkedKernelIndex(offset, "host_fb_write offset"),
            this.readKernelBytes(srcPtr, len),
          );
        },
        // /dev/dri/renderD128 hooks. v1 CpuShared tier: pixel storage
        // for a bo lives in the owning process's wasm Memory at the
        // bind range. The registry is pure metadata.
        host_gbm_bo_create: (
          pid: number,
          bo_id: number,
          size: bigint,
          w: number,
          h: number,
          stride: number,
        ): number => {
          let checkedSize: number;
          try {
            checkedSize = this.checkedKernelIndex(
              size,
              "host_gbm_bo_create size",
            );
          } catch {
            return -75; // EOVERFLOW
          }
          try {
            this.bos.create({ pid, bo_id, size: checkedSize, w, h, stride });
            return 0;
          } catch {
            return -12; // ENOMEM
          }
        },
        host_gbm_bo_destroy: (pid: number, bo_id: number): void => {
          this.bos.destroy(pid, bo_id);
        },
        host_gbm_bo_bind: (
          pid: number,
          bo_id: number,
          addr: KernelPointer,
          len: KernelPointer,
        ): number => {
          try {
            // The worker grows and primes process memory after this callback,
            // so current process-memory bounds are not yet meaningful. The
            // Rust BO owns this mapping contract; the registry caps later
            // copies to the BO's size and rechecks current memory bounds.
            const binding = this.checkedKernelSpan(
              addr,
              len,
              Number.MAX_SAFE_INTEGER,
              "host_gbm_bo_bind BO range",
            );
            return this.bos.bind(
              pid,
              bo_id,
              binding.offset,
              binding.length,
            );
          } catch {
            return -75; // EOVERFLOW
          }
        },
        host_gbm_bo_unbind: (
          pid: number,
          bo_id: number,
          _addr: KernelPointer,
          _len: KernelPointer,
        ): void => {
          this.bos.unbind(pid, bo_id);
        },
        // /dev/dri/renderD128 GL hooks. The cmdbuf lives in the process's
        // wasm Memory SAB; submit/query reach into it via the embedder-
        // supplied `getProcessMemory` callback. Without an attached
        // canvas the create-context call leaves `b.gl = null` and
        // submit/query become silent no-ops, so kernels that haven't
        // wired a renderer (Node tests, headless smoke runs) stay safe.
        host_gl_bind: (pid: number, addr: KernelPointer, len: KernelPointer): void => {
          const binding = this.checkedKernelSpan(
            addr,
            len,
            Number.MAX_SAFE_INTEGER,
            "host_gl_bind process range",
          );
          this.gl.bind({
            pid,
            cmdbufAddr: binding.offset,
            cmdbufLen: binding.length,
          });
        },
        host_gl_unbind: (pid: number): void => {
          this.gl.unbind(pid);
        },
        host_gl_create_context: (
          pid: number, ctxId: number,
          _attrsPtr: KernelPointer, _attrsLen: KernelPointer,
        ): void => {
          const b = this.gl.get(pid);
          if (!b) return;
          b.contextId = ctxId;
          if (b.forward) {
            b.forward.onCreateContext();
            return;
          }
          if (!b.canvas) {
            // Auto-attach the KMS scanout canvas if this pid holds DRM
            // master on a CRTC the embedder has registered with
            // `kmsAttachCanvas`. Without this, a libdrm/libgbm/EGL
            // program (e.g. modeset.c) that drove drmModeSetCrtc and
            // is about to call eglCreateContext would silently no-op
            // every shader compile/link/draw because `b.canvas` stays
            // null and `b.gl` is never built.
            const crtc = this.kms.masterCrtcForPid(pid);
            if (crtc != null) {
              const canvas = this.callbacks.getKmsCanvas?.(crtc);
              if (canvas) {
                // Resize the OffscreenCanvas's drawing buffer to match
                // the kernel-side FB before WebGL2 binds, so glViewport
                // and gl_FragCoord operate on the full surface rather
                // than the default 300×150 corner. Modeset programs set
                // their viewport from CANVAS_W/H (the FB they registered
                // via drmModeAddFB2) and would otherwise render into a
                // tiny clipped region of a default-sized canvas.
                const fb = this.kms.currentFb(crtc);
                if (fb && (canvas.width !== fb.width || canvas.height !== fb.height)) {
                  canvas.width = fb.width;
                  canvas.height = fb.height;
                }
                this.gl.attachCanvas(pid, canvas);
                b.canvas = canvas;
                this.callbacks.markKmsCanvasGlOwned?.(crtc);
              }
            }
            if (!b.canvas) return;
          }
          const ctx = b.canvas.getContext("webgl2", {
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
          }) as WebGL2RenderingContext | null;
          if (ctx) {
            // Mirror main-forward.ts: enable the WebGL2 float extensions
            // so RGBA16F framebuffers are renderable and float textures
            // accept LINEAR filtering. Without these, ping-pong sims
            // (Pavel-style fluid, GPU-side image processing) hit
            // GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT silently.
            ctx.getExtension("EXT_color_buffer_float");
            ctx.getExtension("OES_texture_float_linear");
            ctx.getExtension("EXT_float_blend");
          }
          b.gl = ctx;
        },
        host_gl_destroy_context: (pid: number, _ctxId: number): void => {
          const b = this.gl.get(pid);
          if (!b) return;
          b.gl = null;
          b.contextId = null;
          b.currentProgram = null;
          if (b.forward) b.forward.onDestroyContext();
        },
        host_gl_create_surface: (
          pid: number, surfaceId: number,
          _attrsPtr: KernelPointer, _attrsLen: KernelPointer,
        ): void => {
          const b = this.gl.get(pid);
          if (b) b.surfaceId = surfaceId;
        },
        host_gl_destroy_surface: (pid: number, _surfaceId: number): void => {
          const b = this.gl.get(pid);
          if (b) b.surfaceId = null;
        },
        host_gl_make_current: (
          _pid: number, _ctxId: number, _surfaceId: number,
        ): void => {
          // No-op: WebGL2 binds context per `getContext()`; we already
          // track ctx + surface ids on the binding.
        },
        host_gl_submit: (
          pid: number, offset: KernelPointer, length: KernelPointer,
        ): number => {
          const b = this.gl.get(pid);
          if (!b) return -5; // EIO: kernel/host GL state diverged.
          if (!b.forward && !b.gl) return 0;
          let submission: { offset: number; length: number; end: number };
          try {
            submission = this.checkedKernelSpan(
              offset,
              length,
              b.cmdbufLen,
              "host_gl_submit command range",
            );
          } catch {
            return -22; // EINVAL
          }
          if (!b.cmdbufView) {
            const memory = this.callbacks.getProcessMemory?.(pid);
            if (!memory) return -5; // EIO
            try {
              b.cmdbufView = new Uint8Array(
                memory.buffer,
                b.cmdbufAddr,
                b.cmdbufLen,
              );
            } catch {
              return -5; // EIO
            }
          }
          if (b.forward) {
            const rc = validateCommandBuffer(
              b.cmdbufView,
              submission.offset,
              submission.length,
            );
            if (rc < 0) return rc;
            b.forward.onSubmit(
              b.cmdbufView.slice(submission.offset, submission.end),
            );
            return 0;
          }
          this.gl_submit_queue.enqueue(b, {
            memorySab: b.cmdbufView.buffer as ArrayBufferLike,
            off: submission.offset,
            len: submission.length,
          });
          return drainSubmitQueue(
            this.gl_submit_queue,
            (bb) => {
              if (!bb.gl) return null;
              let mux = this.gl_muxers.get(bb.gl);
              if (!mux) {
                mux = new GlMuxer(bb.gl);
                this.gl_muxers.set(bb.gl, mux);
              }
              return mux;
            },
            (bb, off, len) => decodeAndDispatch(bb, off, len),
          );
        },
        host_gl_present: (_pid: number): void => {
          // RAF-driven canvas presentation handles itself in v1. Hook
          // is here for explicit-swap / pbuffer paths in v2.
        },
        host_gl_query: (
          pid: number, op: number,
          inPtr: KernelPointer, inLen: KernelPointer,
          outPtr: KernelPointer, outLen: KernelPointer,
        ): number => {
          const b = this.gl.get(pid);
          if (!b || !b.gl) return -1;
          let inputLength: number;
          let outputLength: number;
          try {
            inputLength = this.checkedKernelIndex(
              inLen,
              "host_gl_query input length",
            );
            outputLength = this.checkedKernelIndex(
              outLen,
              "host_gl_query output length",
            );
            if (outputLength > 0) {
              if (!this.memory) return -5;
              // Preflight before touching WebGL state. A bad Rust destination
              // must not execute a query and only then discover EFAULT.
              checkedWasmImportMemoryRange(
                this.memory,
                outPtr,
                outputLength,
                this.kernelPtrWidth,
                "host_gl_query destination",
              );
            }
          } catch {
            return -14; // EFAULT
          }
          let inBuf: Uint8Array;
          try {
            inBuf = inputLength > 0
              ? this.readKernelBytes(inPtr, inputLength)
              : new Uint8Array(0);
          } catch {
            return -14; // EFAULT
          }
          const outBuf = new Uint8Array(outputLength);
          const written = runGlQuery(b, op, inBuf, outBuf);
          if (!Number.isSafeInteger(written)) return -5;
          if (written < 0) return written;
          if (written > outputLength) return -5;
          if (written > 0) {
            this.writeKernelBytes(
              outPtr,
              outputLength,
              outBuf.subarray(0, written),
            );
          }
          return written;
        },
        host_kms_set_master: (pid: number): void => { this.kms.setMasterPid(pid); },
        host_kms_drop_master: (_pid: number): void => { this.kms.dropMaster(); },
        host_proc_write_bytes: (
          pid: number,
          addr: number,
          src_ptr: KernelPointer,
          len: number,
        ): number => {
          const procMem = this.callbacks.getProcessMemory?.(pid);
          if (!procMem) return -14;
          try {
            checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_write_bytes process destination",
            );
            const src = this.readKernelBytes(src_ptr, len);
            // Reacquire the process buffer after copying the kernel source:
            // another process worker may have grown it in the meantime.
            const destination = checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_write_bytes process destination",
            );
            new Uint8Array(procMem.buffer).set(src, destination.pointer);
            return 0;
          } catch {
            return -14;
          }
        },
        host_proc_read_bytes: (
          pid: number,
          addr: number,
          dst_ptr: KernelPointer,
          len: number,
        ): number => {
          const procMem = this.callbacks.getProcessMemory?.(pid);
          if (!procMem) return -14;
          try {
            if (!this.memory) return -5;
            // Prove the Rust-owned destination before reading caller bytes so
            // an invalid kernel range cannot consume a source operation.
            checkedWasmImportMemoryRange(
              this.memory,
              dst_ptr,
              len,
              this.kernelPtrWidth,
              "host_proc_read_bytes kernel destination",
            );
            const source = checkedWasmImportMemoryRange(
              procMem,
              addr,
              len,
              4,
              "host_proc_read_bytes process source",
            );
            const copy = new Uint8Array(
              procMem.buffer,
              source.pointer,
              source.length,
            ).slice();
            this.writeKernelBytes(dst_ptr, len, copy);
            return 0;
          } catch {
            return -14;
          }
        },
        host_kms_mode_info: (
          connector_id: number,
          out_ptr: KernelPointer,
        ): void => {
          const canvas = this.callbacks.getKmsCanvas?.(connector_id);
          const bytes = kmsModeInfoBytes(canvas?.width, canvas?.height);
          this.writeKernelBytes(
            out_ptr,
            STRUCT_SIZE_WPK_DRM_MODE_MODEINFO,
            bytes,
          );
        },
        host_kms_addfb: (
          _pid: number,
          fb_id: number,
          bo_id: number,
          width: number,
          height: number,
          pixel_format: number,
          pitch: number,
        ): number => {
          this.kms.addFb({ fb_id, bo_id, width, height, pixel_format, pitch });
          return 0;
        },
        host_kms_rmfb: (_pid: number, fb_id: number): void => { this.kms.rmFb(fb_id); },
        host_kms_set_fb: (_pid: number, crtc_id: number, fb_id: number): void => {
          this.kms.setFb(crtc_id, fb_id);
        },
      },
    };
  }

  /**
   * UNSAFE trusted-embedder escape hatch for tests and low-level diagnostics.
   *
   * Direct mutation bypasses KernelScratchRegion ownership, capacity, and
   * lifetime checks. Runtime transfer code must use the typed public methods
   * instead of pairing this memory with allocator exports.
   */
  getMemory(): WebAssembly.Memory | null {
    return this.memory;
  }

  /**
   * UNSAFE trusted-embedder escape hatch for tests and low-level diagnostics.
   *
   * Calling pointer-returning exports and writing through getMemory() is
   * outside the checked scratch-transfer contract.
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

  /** Copy `len` bytes from kernel memory at `ptr` into a non-shared
   *  Uint8Array. Used by host imports that consume kernel-scratch
   *  payloads (e.g. host_fb_write).
   */
  private readKernelBytes(
    ptr: KernelPointer,
    len: number | bigint,
  ): Uint8Array {
    if (!this.memory) throw new Error("Kernel not initialized");
    const range = checkedWasmImportMemoryRange(
      this.memory,
      ptr,
      len,
      this.kernelPtrWidth,
      "kernel import source",
    );
    return this.getMemoryBuffer().slice(range.pointer, range.end);
  }

  /** Write `bytes` into kernel memory at `ptr`. Used by host imports
   *  that return kernel-scratch payloads (e.g. host_gl_query,
   *  host_kms_mode_info, host_proc_read_bytes).
   */
  private writeKernelBytes(
    ptr: KernelPointer,
    capacity: number | bigint,
    bytes: Uint8Array,
  ): void {
    if (!this.memory) throw new Error("Kernel not initialized");
    const range = checkedWasmImportMemoryRange(
      this.memory,
      ptr,
      capacity,
      this.kernelPtrWidth,
      "kernel import destination",
    );
    const exactBytes = intrinsicUint8ArrayView(
      bytes,
      "kernel import output",
    );
    if (exactBytes.byteLength > range.length) {
      throw new Error(
        `kernel import output ${exactBytes.byteLength} exceeds capacity ${range.length}`,
      );
    }
    this.getMemoryBuffer().set(exactBytes, range.pointer);
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
    pathPtr: KernelPointer,
    pathLen: number,
    flags: number,
    mode: number,
  ): bigint {
    try {
      const pathBytes = this.readKernelBytes(pathPtr, pathLen);
      const path = new TextDecoder().decode(pathBytes);
      return BigInt(this.io.open(path, flags, mode));
    } catch (e) {
      return BigInt(negErrno(e));
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

    const retained = this.retainedHostFileHandles.get(h);
    if (retained) {
      retained.descriptorClosePending = true;
      return 0;
    }

    try {
      return this.io.close(h);
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_read(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handle 0 (stdin): return 0 (no stdin support yet).
   * Other handles: delegate to PlatformIO.
   */
  private hostRead(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
  ): number {
    const h = Number(handle);
    let destinationCapacity: number;
    try {
      if (!this.memory) return -5;
      destinationCapacity = checkedWasmImportMemoryRange(
        this.memory,
        bufPtr,
        bufLen,
        this.kernelPtrWidth,
        "host_read destination",
      ).length;
    } catch {
      return -14; // EFAULT
    }
    // WHY: never lend a live view of Rust-owned memory to PlatformIO. A
    // backend can accidentally retain that view or reenter the kernel. Stage
    // into host memory, validate the producer count, then publish once through
    // the pointer-plus-capacity helper.
    const staged = new Uint8Array(destinationCapacity);
    const publish = (result: number): number => {
      if (
        !Number.isSafeInteger(result)
        || result < 0
        || result > destinationCapacity
      ) {
        return -5;
      }
      if (result > 0) {
        try {
          this.writeKernelBytes(
            bufPtr,
            destinationCapacity,
            staged.subarray(0, result),
          );
        } catch {
          return -14;
        }
      }
      return result;
    };

    // Check shared pipe registry
    const readEntry = this.sharedPipes.get(h);
    if (readEntry) {
      return publish(readEntry.pipe.read(staged));
    }

    // stdin
    if (h === 0) {
      if (this.callbacks.onStdin) {
        const data = this.callbacks.onStdin(bufLen);
        if (data === null) return 0; // EOF
        let exactData: Uint8Array;
        try {
          exactData = intrinsicUint8ArrayView(data, "stdin callback output");
        } catch {
          return -5; // EIO: the callback violated its byte-source contract.
        }
        if (exactData.byteLength === 0) {
          return -11; // EAGAIN — no data yet, retry later
        }
        const n = Math.min(exactData.byteLength, destinationCapacity);
        staged.set(
          new Uint8Array(
            exactData.buffer,
            exactData.byteOffset,
            n,
          ),
        );
        return publish(n);
      }
      return 0; // EOF when no stdin callback
    }

    try {
      return publish(
        this.io.read(h, staged, null, destinationCapacity),
      );
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_write(handle: i64, buf_ptr, buf_len) -> i32
   *
   * For handles 1 (stdout) and 2 (stderr): uses callback if provided,
   * falls back to process.stdout/stderr (Node.js), then console (browser).
   * Other handles: delegate to PlatformIO.
   */
  private hostWrite(
    handle: bigint,
    bufPtr: KernelPointer,
    bufLen: number,
  ): number {
    const h = Number(handle);
    let data: Uint8Array;
    try {
      data = this.readKernelBytes(bufPtr, bufLen);
    } catch (error) {
      return negErrno(error);
    }

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
      const written = this.io.write(h, data, null, data.byteLength);
      return Number.isSafeInteger(written)
        && written >= 0
        && written <= data.byteLength
        ? written
        : -5;
    } catch (e) {
      return negErrno(e);
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
    } catch (e) {
      return BigInt(negErrno(e));
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
  private hostFstat(handle: bigint, statPtr: KernelPointer): number {
    const h = Number(handle);

    try {
      const stat = this.io.fstat(h);
      this.writeStatToMemory(statPtr, stat);
      if (this.fstatHandleCapture) this.fstatHandleCapture.handle = h;
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * Write a StatResult into the WasmStat struct at the given Wasm memory offset.
   */
  private writeStatToMemory(ptr: KernelPointer, stat: StatResult): void {
    // Build the complete structure in host-owned memory, then publish it only
    // after the pointer and Rust-declared fixed capacity have both passed.
    const bytes = new Uint8Array(WASM_STAT_SIZE);
    const dv = new DataView(bytes.buffer);

    dv.setBigUint64(0, exactU64(stat.dev, "st_dev"), true); // st_dev
    dv.setBigUint64(8, exactU64(stat.ino, "st_ino"), true); // st_ino
    dv.setUint32(16, stat.mode, true); // st_mode
    dv.setUint32(20, stat.nlink, true); // st_nlink
    dv.setUint32(24, stat.uid, true); // st_uid
    dv.setUint32(28, stat.gid, true); // st_gid
    dv.setBigUint64(32, BigInt(stat.size), true); // st_size

    // Convert millisecond timestamps to seconds + nanoseconds.
    const atimeSec = Math.floor(stat.atimeMs / 1000);
    const atimeNsec = Math.floor((stat.atimeMs % 1000) * 1_000_000);
    dv.setBigUint64(40, BigInt(atimeSec), true); // st_atime_sec
    dv.setUint32(48, atimeNsec, true); // st_atime_nsec

    const mtimeSec = Math.floor(stat.mtimeMs / 1000);
    const mtimeNsec = Math.floor((stat.mtimeMs % 1000) * 1_000_000);
    dv.setBigUint64(56, BigInt(mtimeSec), true); // st_mtime_sec
    dv.setUint32(64, mtimeNsec, true); // st_mtime_nsec

    const ctimeSec = Math.floor(stat.ctimeMs / 1000);
    const ctimeNsec = Math.floor((stat.ctimeMs % 1000) * 1_000_000);
    dv.setBigUint64(72, BigInt(ctimeSec), true); // st_ctime_sec
    dv.setUint32(80, ctimeNsec, true); // st_ctime_nsec
    // _pad at offset 84 already zeroed
    this.writeKernelBytes(ptr, WASM_STAT_SIZE, bytes);
  }

  private writeStatfsToMemory(
    ptr: KernelPointer,
    statfs: StatfsResult,
  ): void {
    const bytes = new Uint8Array(WASM_STATFS_SIZE);
    const dv = new DataView(bytes.buffer);

    const u32 = (value: number): number => {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.floor(value)) >>> 0;
    };
    const u64 = (value: number): bigint => {
      if (!Number.isFinite(value) || value <= 0) return 0n;
      return BigInt(Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
    };

    dv.setUint32(0, u32(statfs.type), true);
    dv.setUint32(4, u32(statfs.bsize), true);
    dv.setBigUint64(8, u64(statfs.blocks), true);
    dv.setBigUint64(16, u64(statfs.bfree), true);
    dv.setBigUint64(24, u64(statfs.bavail), true);
    dv.setBigUint64(32, u64(statfs.files), true);
    dv.setBigUint64(40, u64(statfs.ffree), true);
    dv.setBigUint64(48, u64(statfs.fsid), true);
    dv.setUint32(56, u32(statfs.namelen), true);
    dv.setUint32(60, u32(statfs.frsize), true);
    dv.setUint32(64, u32(statfs.flags), true);
    this.writeKernelBytes(ptr, WASM_STATFS_SIZE, bytes);
  }

  // ---- Phase 2: Path-based and directory host imports ----

  /**
   * Read a UTF-8 path string from Wasm memory.
   */
  private readPathFromMemory(ptr: KernelPointer, len: number): string {
    const pathBytes = this.readKernelBytes(ptr, len);
    return new TextDecoder().decode(pathBytes);
  }

  /**
   * host_stat(path_ptr, path_len, stat_ptr) -> i32
   */
  private hostStat(
    pathPtr: KernelPointer,
    pathLen: number,
    statPtr: KernelPointer,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.stat(path);
      this.writeStatToMemory(statPtr, stat);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_lstat(path_ptr, path_len, stat_ptr) -> i32
   */
  private hostLstat(
    pathPtr: KernelPointer,
    pathLen: number,
    statPtr: KernelPointer,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const stat = this.io.lstat(path);
      this.writeStatToMemory(statPtr, stat);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  private hostStatfs(
    pathPtr: KernelPointer,
    pathLen: number,
    statfsPtr: KernelPointer,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const statfs = this.io.statfs(path);
      this.writeStatfsToMemory(statfsPtr, statfs);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  private hostPathconf(
    pathPtr: KernelPointer,
    pathLen: number,
    name: number,
    valuePtr: KernelPointer,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const value = this.io.pathconf(path, name);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, BigInt(value ?? -1), true);
      this.writeKernelBytes(valuePtr, bytes.byteLength, bytes);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  private hostFpathconf(
    handle: bigint,
    name: number,
    valuePtr: KernelPointer,
  ): number {
    try {
      const value = this.io.fpathconf(Number(handle), name);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, BigInt(value ?? -1), true);
      this.writeKernelBytes(valuePtr, bytes.byteLength, bytes);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_mkdir(path_ptr, path_len, mode) -> i32
   */
  private hostMkdir(
    pathPtr: KernelPointer,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.mkdir(path, mode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_rmdir(path_ptr, path_len) -> i32
   */
  private hostRmdir(pathPtr: KernelPointer, pathLen: number): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.rmdir(path);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_unlink(path_ptr, path_len) -> i32
   */
  private hostUnlink(pathPtr: KernelPointer, pathLen: number): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.unlink(path);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_rename(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  private hostRename(
    oldPtr: KernelPointer,
    oldLen: number,
    newPtr: KernelPointer,
    newLen: number,
  ): number {
    try {
      const oldPath = this.readPathFromMemory(oldPtr, oldLen);
      const newPath = this.readPathFromMemory(newPtr, newLen);
      this.io.rename(oldPath, newPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_link(old_ptr, old_len, new_ptr, new_len) -> i32
   */
  private hostLink(
    oldPtr: KernelPointer,
    oldLen: number,
    newPtr: KernelPointer,
    newLen: number,
  ): number {
    try {
      const existingPath = this.readPathFromMemory(oldPtr, oldLen);
      const newPath = this.readPathFromMemory(newPtr, newLen);
      this.io.link(existingPath, newPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_symlink(target_ptr, target_len, link_ptr, link_len) -> i32
   */
  private hostSymlink(
    targetPtr: KernelPointer,
    targetLen: number,
    linkPtr: KernelPointer,
    linkLen: number,
  ): number {
    try {
      const target = this.readPathFromMemory(targetPtr, targetLen);
      const linkPath = this.readPathFromMemory(linkPtr, linkLen);
      this.io.symlink(target, linkPath);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_readlink(path_ptr, path_len, buf_ptr, buf_len) -> i32
   *
   * Returns the number of bytes written to the buffer, or -1 on error.
   */
  private hostReadlink(
    pathPtr: KernelPointer,
    pathLen: number,
    bufPtr: KernelPointer,
    bufLen: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      if (!this.memory) return -5;
      checkedWasmImportMemoryRange(
        this.memory,
        bufPtr,
        bufLen,
        this.kernelPtrWidth,
        "host_readlink destination",
      );
      const target = this.io.readlink(path);
      const encoded = new TextEncoder().encode(target);
      const n = Math.min(encoded.length, bufLen);
      this.writeKernelBytes(bufPtr, bufLen, encoded.subarray(0, n));
      return n;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_chmod(path_ptr, path_len, mode) -> i32
   */
  private hostChmod(
    pathPtr: KernelPointer,
    pathLen: number,
    mode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.chmod(path, mode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_chown(path_ptr, path_len, uid, gid) -> i32
   */
  private hostChown(
    pathPtr: KernelPointer,
    pathLen: number,
    uid: number,
    gid: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.chown(path, uid, gid);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_lchown(path_ptr, path_len, uid, gid) -> i32
   */
  private hostLchown(
    pathPtr: KernelPointer,
    pathLen: number,
    uid: number,
    gid: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.lchown(path, uid, gid);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_access(path_ptr, path_len, amode) -> i32
   */
  private hostAccess(
    pathPtr: KernelPointer,
    pathLen: number,
    amode: number,
  ): number {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      this.io.access(path, amode);
      return 0;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_utimensat(path_ptr, path_len, atime_sec, atime_nsec, mtime_sec, mtime_nsec) -> i32
   */
  private hostUtimensat(
    pathPtr: KernelPointer,
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
    statusPtr: KernelPointer,
  ): number {
    const hasStatus = typeof statusPtr === "bigint"
      ? statusPtr !== 0n
      : statusPtr !== 0;
    if (hasStatus) {
      try {
        if (!this.memory) return -5;
        // Validate before either wait backend can consume a child state. The
        // final write repeats this proof against the then-current buffer.
        checkedWasmImportMemoryRange(
          this.memory,
          statusPtr,
          4,
          this.kernelPtrWidth,
          "host_waitpid status destination",
        );
      } catch {
        return -14; // EFAULT
      }
    }
    // If we have a waitpid callback + SAB, use blocking host delegation
    if (this.waitpidSab && this.callbacks.onWaitpid) {
      const view = new Int32Array(this.waitpidSab);
      Atomics.store(view, 0, 0); // flag = waiting
      Atomics.store(view, 1, 0); // result pid
      Atomics.store(view, 2, 0); // status

      this.callbacks.onWaitpid(pid, options);

      // Block until host signals completion
      Atomics.wait(view, 0, 0);

      const resultPid = Atomics.load(view, 1);
      const resultStatus = Atomics.load(view, 2);

      if (resultPid < 0) {
        return resultPid; // negative errno
      }

      if (hasStatus) {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, resultStatus, true);
        try {
          this.writeKernelBytes(statusPtr, bytes.byteLength, bytes);
        } catch {
          return -14; // EFAULT
        }
      }
      return resultPid;
    }

    // Fallback to PlatformIO
    if (!this.io.waitpid) {
      return -10; // -ECHILD
    }
    let result: { pid: number; status: number };
    try {
      result = this.io.waitpid(pid, options);
    } catch {
      return -10; // -ECHILD
    }
    if (hasStatus) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, result.status, true);
      try {
        this.writeKernelBytes(statusPtr, bytes.byteLength, bytes);
      } catch {
        return -14; // EFAULT
      }
    }
    return result.pid;
  }

  /**
   * host_opendir(path_ptr, path_len) -> i64
   *
   * Returns a directory handle as i64, or -1 on error.
   */
  private hostOpendir(pathPtr: KernelPointer, pathLen: number): bigint {
    try {
      const path = this.readPathFromMemory(pathPtr, pathLen);
      const handle = this.io.opendir(path);
      // Backends may reuse numeric handles after close. Never let an entry
      // staged for an older iterator leak into the new one.
      this.pendingDirectoryEntries.delete(handle);
      return BigInt(handle);
    } catch (e) {
      return BigInt(negErrno(e));
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
    direntPtr: KernelPointer,
    namePtr: KernelPointer,
    nameLen: number,
  ): number {
    try {
      const h = Number(dirHandle);
      let dirEntry = this.pendingDirectoryEntries.get(h);
      if (dirEntry === undefined) {
        const next = this.io.readdir(h);
        if (next === null) return 0; // end of directory
        this.pendingDirectoryEntries.set(h, next);
        dirEntry = next;
      }

      // Write WasmDirent: d_ino(u64) + d_type(u32) + d_namlen(u32)
      const encoded = new TextEncoder().encode(dirEntry.name);
      const n = Math.min(encoded.length, nameLen);
      if (!this.memory) throw new Error("Kernel not initialized");
      // Preflight both destinations before publishing either half of the
      // aggregate record. A retry must never observe a new dirent paired with
      // stale name bytes.
      checkedWasmImportMemoryRange(
        this.memory,
        direntPtr,
        WASM_DIRENT_SIZE,
        this.kernelPtrWidth,
        "host_readdir dirent destination",
      );
      checkedWasmImportMemoryRange(
        this.memory,
        namePtr,
        nameLen,
        this.kernelPtrWidth,
        "host_readdir name destination",
      );
      const dirent = new Uint8Array(WASM_DIRENT_SIZE);
      const view = new DataView(dirent.buffer);
      view.setBigUint64(0, BigInt(dirEntry.ino), true);
      view.setUint32(8, dirEntry.type, true);
      view.setUint32(12, n, true);
      this.writeKernelBytes(direntPtr, WASM_DIRENT_SIZE, dirent);
      this.writeKernelBytes(namePtr, nameLen, encoded.subarray(0, n));

      this.pendingDirectoryEntries.delete(h);
      return 1;
    } catch (e) {
      return negErrno(e);
    }
  }

  /**
   * host_closedir(dir_handle: i64) -> i32
   */
  private hostClosedir(dirHandle: bigint): number {
    const h = Number(dirHandle);
    try {
      this.io.closedir(h);
      return 0;
    } catch {
      return -1;
    } finally {
      this.pendingDirectoryEntries.delete(h);
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
    secPtr: KernelPointer,
    nsecPtr: KernelPointer,
  ): number {
    try {
      const result = this.io.clockGettime(clockId);
      if (!this.memory) throw new Error("Kernel not initialized");
      checkedWasmImportMemoryRange(
        this.memory,
        secPtr,
        8,
        this.kernelPtrWidth,
        "host_clock_gettime seconds destination",
      );
      checkedWasmImportMemoryRange(
        this.memory,
        nsecPtr,
        8,
        this.kernelPtrWidth,
        "host_clock_gettime nanoseconds destination",
      );
      const seconds = new Uint8Array(8);
      const nanoseconds = new Uint8Array(8);
      new DataView(seconds.buffer).setBigInt64(0, BigInt(result.sec), true);
      new DataView(nanoseconds.buffer).setBigInt64(
        0,
        BigInt(result.nsec),
        true,
      );
      this.writeKernelBytes(secPtr, seconds.byteLength, seconds);
      this.writeKernelBytes(nsecPtr, nanoseconds.byteLength, nanoseconds);
      return 0;
    } catch (error) {
      return negErrno(error);
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
    if (length < 0n) return -22; // EINVAL
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) return -75; // EOVERFLOW
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

  // ---- Phase 13e: Exec ----

  private hostExec(pathPtr: KernelPointer, pathLen: number): number {
    if (this.callbacks.onExec) {
      try {
        const path = new TextDecoder().decode(
          this.readKernelBytes(pathPtr, pathLen),
        );
        return this.callbacks.onExec(path);
      } catch (error) {
        return negErrno(error);
      }
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

  private hostSetPosixTimer(timerId: number, signo: number, valueMs: number, intervalMs: number): number {
    if (this.callbacks.onPosixTimer) {
      return this.callbacks.onPosixTimer(timerId, signo, valueMs, intervalMs);
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
      svPtr: KernelPointer,
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 8);
      const result = fn(
        domain,
        type,
        protocol,
        this.toKernelPtr(pointer),
      );
      if (result < 0) throw new Error(`socketpair failed: errno ${-result}`);
      const output = scratch.dataView(0, 8);
      return [output.getInt32(0, true), output.getInt32(4, true)];
    });
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
      bufPtr: KernelPointer,
      bufLen: number,
      flags: number,
    ) => number;
    const exactData = intrinsicUint8ArrayView(data, "socket send input");
    return this.requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(exactData);
      const result = fn(
        fd,
        this.toKernelPtr(scratch.address(0, exactData.byteLength)),
        exactData.byteLength,
        flags,
      );
      if (result < 0) throw new Error(`send failed: errno ${-result}`);
      if (!Number.isSafeInteger(result) || result > exactData.byteLength) {
        throw new Error(`send returned invalid byte count ${result}`);
      }
      return result;
    });
  }

  /**
   * Receive data from a connected socket. Returns the received data.
   */
  recv(fd: number, maxLen: number, flags: number = 0): Uint8Array {
    const fn = this.instance!.exports.kernel_recv as (
      fd: number,
      bufPtr: KernelPointer,
      bufLen: number,
      flags: number,
    ) => number;
    if (!Number.isSafeInteger(maxLen) || maxLen < 0) {
      throw new Error("recv length must be a non-negative safe integer");
    }
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, maxLen);
      const result = fn(fd, this.toKernelPtr(pointer), maxLen, flags);
      if (result < 0) throw new Error(`recv failed: errno ${-result}`);
      if (!Number.isSafeInteger(result) || result > maxLen) {
        throw new Error(`recv returned invalid byte count ${result}`);
      }
      return scratch.copyOut(0, result);
    });
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
      fdsPtr: KernelPointer,
      nfds: number,
      timeout: number,
    ) => number;
    const nfds = fds.length;
    if (!Number.isSafeInteger(nfds) || nfds > 1024) {
      throw new Error("poll descriptor count exceeds public API limit 1024");
    }
    return this.requireApiScratch().withLease((scratch) => {
      const byteLength = nfds * 8;
      const pointer = scratch.address(0, byteLength);
      const view = scratch.dataView(0, byteLength);
      for (let index = 0; index < nfds; index++) {
        const offset = index * 8;
        view.setInt32(offset, fds[index].fd, true);
        view.setInt16(offset + 4, fds[index].events, true);
        view.setInt16(offset + 6, 0, true);
      }
      const result = fn(this.toKernelPtr(pointer), nfds, timeout);
      if (result < 0) throw new Error(`poll failed: errno ${-result}`);
      const resultView = scratch.dataView(0, byteLength);
      return fds.map((entry, index) => ({
        fd: entry.fd,
        events: entry.events,
        revents: resultView.getInt16(index * 8 + 6, true),
      }));
    });
  }

  /**
   * Get a socket option value.
   */
  getsockopt(fd: number, level: number, optname: number): number {
    const fn = this.instance!.exports.kernel_getsockopt as (
      fd: number,
      level: number,
      optname: number,
      optvalPtr: KernelPointer,
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 4);
      const result = fn(fd, level, optname, this.toKernelPtr(pointer));
      if (result < 0) throw new Error(`getsockopt failed: errno ${-result}`);
      return scratch.dataView(0, 4).getUint32(0, true);
    });
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
   * Get terminal attributes in musl's exact 60-byte struct termios layout.
   */
  tcgetattr(fd: number): Uint8Array {
    const fn = this.instance!.exports.kernel_tcgetattr as (
      fd: number,
      bufPtr: KernelPointer,
      bufLen: number,
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 60);
      const result = fn(fd, this.toKernelPtr(pointer), 60);
      if (result < 0) throw new Error(`tcgetattr failed: errno ${-result}`);
      return scratch.copyOut(0, 60);
    });
  }

  /**
   * Set terminal attributes.
   * action: 0=TCSANOW, 1=TCSADRAIN, 2=TCSAFLUSH
   */
  tcsetattr(fd: number, action: number, attrs: Uint8Array): void {
    const fn = this.instance!.exports.kernel_tcsetattr as (
      fd: number,
      action: number,
      bufPtr: KernelPointer,
      bufLen: number,
    ) => number;
    const exactAttrs = intrinsicUint8ArrayView(
      attrs,
      "terminal attributes input",
    );
    this.requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(exactAttrs);
      const result = fn(
        fd,
        action,
        this.toKernelPtr(scratch.address(0, exactAttrs.byteLength)),
        exactAttrs.byteLength,
      );
      if (result < 0) throw new Error(`tcsetattr failed: errno ${-result}`);
    });
  }

  /**
   * Perform an ioctl operation.
   * For TIOCGWINSZ (0x5413): returns 8-byte buffer (ws_row, ws_col, ws_xpixel, ws_ypixel as u16 LE)
   * For TIOCSWINSZ (0x5414): pass 8-byte buffer to set window size
   */
  ioctl(
    fd: number,
    request: number,
    arg?: Uint8Array | number,
  ): Uint8Array {
    const fn = this.instance!.exports.kernel_ioctl as (
      fd: number,
      request: number,
      bufPtr: KernelPointer,
      bufLen: number,
      processPointerWidth: number,
    ) => number;
    const contract = IOCTL_REQUESTS[request >>> 0];
    const wasm32Size = contract?.wasm32Size;
    if (contract && wasm32Size === null) {
      throw new Error(
        `ioctl 0x${(request >>> 0).toString(16)} has no wasm32 layout`,
      );
    }
    const expectedSize = wasm32Size ?? 0;
    return this.requireApiScratch().withLease((scratch) => {
      let bufLen = 0;
      let argument: KernelPointer = 0;
      if (contract?.argKind === "pointer") {
        if (typeof arg === "number") {
          throw new Error("pointer ioctl requires a byte buffer");
        }
        bufLen = expectedSize;
        if (arg && arg.byteLength !== bufLen) {
          throw new Error(
            `ioctl buffer is ${arg.byteLength} bytes; expected ${bufLen}`,
          );
        }
        if (!arg && contract.direction !== "out") {
          throw new Error("input ioctl requires a byte buffer");
        }
        if (arg) scratch.copyFrom(arg, 0, 0, bufLen);
        else scratch.fill(0, 0, bufLen);
        argument = this.toKernelPtr(scratch.address(0, bufLen));
      } else if (contract?.argKind === "scalar-i32") {
        if (!Number.isInteger(arg) || (arg as number) < -0x8000_0000 ||
            (arg as number) > 0xffff_ffff) {
          throw new Error("scalar ioctl argument must fit in 32 bits");
        }
        argument = (arg as number) >>> 0;
      }
      const result = fn(
        fd,
        request,
        argument,
        bufLen,
        4,
      );
      if (result < 0) throw new Error(`ioctl failed: errno ${-result}`);
      return bufLen === 0 ? new Uint8Array(0) : scratch.copyOut(0, bufLen);
    });
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
    const fn = this.instance!.exports.kernel_uname as (
      bufPtr: KernelPointer,
      bufLen: number,
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 325);
      const result = fn(this.toKernelPtr(pointer), 325);
      if (result < 0) throw new Error(`uname failed: errno ${-result}`);
      const bytes = scratch.copyOut(0, 325);
      const decoder = new TextDecoder();
      const readField = (offset: number): string => {
        let end = offset;
        while (end < offset + 65 && bytes[end] !== 0) end++;
        return decoder.decode(bytes.subarray(offset, end));
      };
      return {
        sysname: readField(0),
        nodename: readField(65),
        release: readField(130),
        version: readField(195),
        machine: readField(260),
      };
    });
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
      flags: number, fdPtr: KernelPointer
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 8);
      const result = fn(flags, this.toKernelPtr(pointer));
      if (result < 0) throw new Error(`pipe2 failed: errno ${-result}`);
      const output = scratch.dataView(0, 8);
      return [output.getInt32(0, true), output.getInt32(4, true)];
    });
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
  truncate(path: string, length: number): void {
    const fn = this.instance!.exports.kernel_truncate as (
      pathPtr: KernelPointer,
      pathLen: number,
      lengthLo: number,
      lengthHi: number,
    ) => number;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error("truncate length must be a non-negative safe integer");
    }
    const encodedPath = new TextEncoder().encode(path);
    const lo = length & 0xFFFFFFFF;
    const hi = Math.floor(length / 0x100000000);
    this.requireApiScratch().withLease((scratch) => {
      scratch.copyFrom(encodedPath);
      const result = fn(
        this.toKernelPtr(scratch.address(0, encodedPath.byteLength)),
        encodedPath.byteLength,
        lo,
        hi,
      );
      if (result < 0) throw new Error(`truncate failed: errno ${-result}`);
    });
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
      who: number, bufPtr: KernelPointer, bufLen: number
    ) => number;
    return this.requireApiScratch().withLease((scratch) => {
      const pointer = scratch.address(0, 144);
      const result = fn(who, this.toKernelPtr(pointer), 144);
      if (result < 0) throw new Error(`getrusage failed: errno ${-result}`);
      return scratch.copyOut(0, 144);
    });
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
      nfds: number,
      readPtr: KernelPointer,
      writePtr: KernelPointer,
      exceptPtr: KernelPointer,
      timeout: number,
    ) => number;
    if (!Number.isSafeInteger(nfds) || nfds < 0 || nfds > 1024) {
      throw new Error("select nfds must be between 0 and 1024");
    }
    const validateSet = (set: number[] | null): void => {
      for (const fd of set ?? []) {
        if (!Number.isSafeInteger(fd) || fd < 0 || fd >= nfds) {
          throw new Error(`select fd ${fd} is outside nfds ${nfds}`);
        }
      }
    };
    validateSet(readfds);
    validateSet(writefds);
    validateSet(exceptfds);

    return this.requireApiScratch().withLease((scratch) => {
      scratch.fill(0, 0, 384);
      const readOffset = 0;
      const writeOffset = 128;
      const exceptOffset = 256;
      const readPointer = readfds
        ? scratch.address(readOffset, 128)
        : 0;
      const writePointer = writefds
        ? scratch.address(writeOffset, 128)
        : 0;
      const exceptPointer = exceptfds
        ? scratch.address(exceptOffset, 128)
        : 0;
      const setBits = (offset: number, fds: number[] | null): void => {
        if (!fds) return;
        const bytes = scratch.dataView(offset, 128);
        for (const fd of fds) {
          const byteOffset = Math.floor(fd / 8);
          bytes.setUint8(
            byteOffset,
            bytes.getUint8(byteOffset) | (1 << (fd % 8)),
          );
        }
      };
      setBits(readOffset, readfds);
      setBits(writeOffset, writefds);
      setBits(exceptOffset, exceptfds);
      const result = fn(
        nfds,
        this.toKernelPtr(readPointer),
        this.toKernelPtr(writePointer),
        this.toKernelPtr(exceptPointer),
        0,
      );
      if (result < 0) throw new Error(`select failed: errno ${-result}`);
      const extractReady = (
        offset: number,
        fds: number[] | null,
      ): number[] => {
        if (!fds) return [];
        const bytes = scratch.dataView(offset, 128);
        return fds.filter((fd) =>
          ((bytes.getUint8(Math.floor(fd / 8)) >> (fd % 8)) & 1) !== 0
        );
      };
      return {
        readReady: extractReady(readOffset, readfds),
        writeReady: extractReady(writeOffset, writefds),
        exceptReady: extractReady(exceptOffset, exceptfds),
      };
    });
  }

  // ---- Networking host imports ----

  private hostNetConnect(
    handle: number,
    addrPtr: KernelPointer,
    addrLen: number,
    port: number,
  ): number {
    if (!this.io.network) return -111; // -ECONNREFUSED
    let addr: Uint8Array;
    try {
      addr = this.readKernelBytes(addrPtr, addrLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      this.io.network.connect(handle, addr, port);
      return 0;
    } catch {
      return -111; // -ECONNREFUSED
    }
  }

  private hostNetConnectStatus(handle: number): number {
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      // Backend returns positive errno on failure; kernel expects negative.
      const status = this.io.network.connectStatus(handle);
      return status > 0 ? -status : status;
    } catch {
      return -107; // -ENOTCONN
    }
  }

  private hostNetSend(
    handle: number,
    bufPtr: KernelPointer,
    bufLen: number,
    flags: number,
  ): number {
    if (!this.io.network) return -107; // -ENOTCONN
    let data: Uint8Array;
    try {
      data = this.readKernelBytes(bufPtr, bufLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      const sent = this.io.network.send(handle, data, flags);
      return Number.isSafeInteger(sent)
        && sent >= 0
        && sent <= data.byteLength
        ? sent
        : -5;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN
      return -32; // -EPIPE
    }
  }

  private hostNetRecv(
    handle: number,
    bufPtr: KernelPointer,
    bufLen: number,
    flags: number,
  ): number {
    if (!this.io.network) return -107; // -ENOTCONN
    if (!this.memory) return -5;
    let destination: { pointer: number; length: number; end: number };
    try {
      destination = checkedWasmImportMemoryRange(
        this.memory,
        bufPtr,
        bufLen,
        this.kernelPtrWidth,
        "host_net_recv destination",
      );
    } catch {
      return -14; // -EFAULT
    }
    try {
      const produced = this.io.network.recv(handle, bufLen, flags);
      let data: Uint8Array;
      try {
        data = intrinsicUint8ArrayView(
          produced,
          "network receive output",
        );
      } catch {
        return -5; // EIO: the backend violated its byte-source contract.
      }
      if (data.byteLength > destination.length) {
        return -5; // EIO: backend violated the supplied capacity
      }
      if (data.byteLength > 0) {
        // Recheck after the backend callback in case memory grew while the
        // Rust import was suspended in host code.
        this.writeKernelBytes(bufPtr, bufLen, data);
      }
      return data.byteLength;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN
      return -104; // -ECONNRESET
    }
  }

  private hostNetPoll(handle: number, events: number): number {
    const POLLIN = 0x0001;
    const POLLOUT = 0x0004;
    if (!this.io.network) return -107; // -ENOTCONN
    try {
      if (this.io.network.poll) {
        return this.io.network.poll(handle, events);
      }
      return events & (POLLIN | POLLOUT);
    } catch (e: any) {
      if (typeof e?.errno === "number") return -Math.abs(e.errno);
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

  private hostNetListen(fd: number, port: number, addrA: number, addrB: number, addrC: number, addrD: number): number {
    if (this.callbacks.onNetListen) {
      return this.callbacks.onNetListen(fd, port, [addrA, addrB, addrC, addrD]);
    }
    return 0;
  }

  private hostUdpBind(handle: number, addrA: number, addrB: number, addrC: number, addrD: number, port: number): number {
    if (!this.callbacks.onUdpBind) return 0;
    return this.callbacks.onUdpBind(handle, [addrA, addrB, addrC, addrD], port);
  }

  private hostUdpUnbind(handle: number): number {
    if (!this.callbacks.onUdpUnbind) return 0;
    return this.callbacks.onUdpUnbind(handle);
  }

  private hostUdpSend(
    srcA: number,
    srcB: number,
    srcC: number,
    srcD: number,
    srcPort: number,
    dstA: number,
    dstB: number,
    dstC: number,
    dstD: number,
    dstPort: number,
    dataPtr: KernelPointer,
    dataLen: number,
  ): number {
    if (!this.io.network?.sendDatagram) return -101; // -ENETUNREACH
    let data: Uint8Array;
    try {
      data = this.readKernelBytes(dataPtr, dataLen);
    } catch {
      return -14; // EFAULT
    }
    try {
      let srcAddr = new Uint8Array([srcA, srcB, srcC, srcD]);
      if (
        srcAddr[0] === 0 &&
        srcAddr[1] === 0 &&
        srcAddr[2] === 0 &&
        srcAddr[3] === 0 &&
        this.io.network.localAddress
      ) {
        srcAddr = this.io.network.localAddress.slice();
      }
      const result = this.io.network.sendDatagram({
        srcAddr,
        srcPort,
        dstAddr: new Uint8Array([dstA, dstB, dstC, dstD]),
        dstPort,
        data,
      });
      return result === 0 ? dataLen : -result;
    } catch (e: any) {
      if (typeof e?.errno === "number") return -Math.abs(e.errno);
      return -101; // -ENETUNREACH
    }
  }

  private hostGetaddrinfo(
    namePtr: KernelPointer,
    nameLen: number,
    resultPtr: KernelPointer,
    resultLen: number,
  ): number {
    if (!this.io.network) return -2; // -ENOENT
    try {
      if (!this.memory) return -5;
      checkedWasmImportMemoryRange(
        this.memory,
        resultPtr,
        resultLen,
        this.kernelPtrWidth,
        "host_getaddrinfo destination",
      );
      const name = new TextDecoder().decode(
        this.readKernelBytes(namePtr, nameLen),
      );
      // WHY: EAGAIN is the backend's asynchronous DNS handoff to the kernel
      // retry loop. Keep backend exceptions outside the producer-validation
      // catch so a valid retry signal is not mistaken for hostile bytes.
      const backendAddr = this.io.network.getaddrinfo(name);
      let addr: Uint8Array;
      try {
        addr = intrinsicUint8ArrayView(
          backendAddr,
          "getaddrinfo backend output",
        );
      } catch {
        return -5; // EIO: the backend violated its byte-source contract.
      }
      if (addr.byteLength > resultLen) return -22; // -EINVAL
      this.writeKernelBytes(resultPtr, resultLen, addr);
      return addr.byteLength;
    } catch (e: any) {
      if (e?.errno === 11) return -11; // -EAGAIN — kernel-worker retries
      return negErrno(e);
    }
  }

  private hostFutexWait(
    addr: KernelPointer,
    expected: number,
    timeoutLo: number,
    timeoutHi: number,
  ): number {
    if (!this.memory) return -22; // -EINVAL

    let index: number;
    try {
      const range = checkedWasmImportMemoryRange(
        this.memory,
        addr,
        4,
        this.kernelPtrWidth,
        "host_futex_wait word",
      );
      if (range.pointer % 4 !== 0) return -22; // EINVAL
      index = range.pointer / 4;
    } catch {
      return -14; // EFAULT
    }
    const i32view = new Int32Array(this.memory.buffer);

    // Reconstruct 64-bit timeout_ns from lo/hi
    const timeoutNs = BigInt(timeoutHi >>> 0) * 0x100000000n + BigInt(timeoutLo >>> 0);
    // Convert to signed
    const signed = BigInt.asIntN(64, timeoutNs);

    let timeoutMs: number | undefined;
    if (signed >= 0n) {
      // Convert ns → ms (rounding up to at least 1ms if nonzero)
      timeoutMs = Number(signed / 1_000_000n);
      if (timeoutMs === 0 && signed > 0n) timeoutMs = 1;
    }
    // signed < 0 → infinite wait (undefined timeout)

    let result: "ok" | "not-equal" | "timed-out";
    try {
      result = Atomics.wait(i32view, index, expected, timeoutMs);
    } catch {
      return -22; // EINVAL: memory was not shared or became unusable
    }
    if (result === "timed-out") {
      return -110; // -ETIMEDOUT
    }
    if (result === "not-equal") return -11;  // -EAGAIN
    return 0; // "ok"
  }

  private hostFutexWake(addr: KernelPointer, count: number): number {
    if (!this.memory) return 0;
    let index: number;
    try {
      const range = checkedWasmImportMemoryRange(
        this.memory,
        addr,
        4,
        this.kernelPtrWidth,
        "host_futex_wake word",
      );
      if (range.pointer % 4 !== 0) return -22; // EINVAL
      index = range.pointer / 4;
    } catch {
      return -14; // EFAULT
    }
    const i32view = new Int32Array(this.memory.buffer);
    try {
      return Atomics.notify(i32view, index, count);
    } catch {
      return -22; // EINVAL
    }
  }

}
