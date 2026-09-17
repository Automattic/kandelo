/**
 * Instantiation and placement of the co-resident Rust WASI module.
 *
 * `crates/wasi-module` is the WASI Preview 1 personality for a guest that was
 * not built against Kandelo's own libc glue. It is the exact counterpart of
 * `libc/glue/channel_syscall.c`: where an SDK guest links the channel syscall
 * in as C, a WASI guest gets it as a co-resident wasm side module whose 46
 * exports are spliced straight into the guest's `wasi_snapshot_preview1`
 * import namespace. The guest then calls WASI as ordinary wasm->wasm calls
 * with no JavaScript frame in between.
 *
 * This file is the whole of the host's remaining job: reserve a region,
 * instantiate one module, hand the guest its exports. Everything the calls
 * themselves DO -- errno translation, path resolution against the preopen
 * table, struct re-encoding, the syscall channel handshake -- lives in Rust,
 * which is why `crates/host-native` inherits WASI from the same artifact
 * instead of re-implementing it.
 *
 * No `env.host_*` import is involved. The module's entire import list is
 * `env.memory` plus the three PIC placement globals and its own indirect
 * function table.
 */
import {
  alignUp,
  placeSideModule,
  readSideModuleMemInfo,
} from "./pic-side-module";

/**
 * The 46 WASI Preview 1 entry points, exactly as the specification names them.
 * These are the values spliced into the guest's import namespace.
 */
export const WASI_PREVIEW1_EXPORTS = [
  "args_get",
  "args_sizes_get",
  "environ_get",
  "environ_sizes_get",
  "clock_res_get",
  "clock_time_get",
  "fd_advise",
  "fd_allocate",
  "fd_close",
  "fd_datasync",
  "fd_fdstat_get",
  "fd_fdstat_set_flags",
  "fd_fdstat_set_rights",
  "fd_filestat_get",
  "fd_filestat_set_size",
  "fd_filestat_set_times",
  "fd_pread",
  "fd_prestat_get",
  "fd_prestat_dir_name",
  "fd_pwrite",
  "fd_read",
  "fd_readdir",
  "fd_renumber",
  "fd_seek",
  "fd_sync",
  "fd_tell",
  "fd_write",
  "path_create_directory",
  "path_filestat_get",
  "path_filestat_set_times",
  "path_link",
  "path_open",
  "path_readlink",
  "path_remove_directory",
  "path_rename",
  "path_symlink",
  "path_unlink_file",
  "poll_oneoff",
  "proc_exit",
  "proc_raise",
  "sched_yield",
  "random_get",
  "sock_accept",
  "sock_recv",
  "sock_send",
  "sock_shutdown",
] as const;

/**
 * The module's own lifecycle exports, which are NOT part of the WASI namespace.
 *
 * `wasi_module_init` seeds the shim with the channel offset and the argv/env
 * blob locations; `wasi_module_start` opens the `/` preopen and therefore
 * issues a syscall, which is why it is separate from `init`.
 */
export const WASI_MODULE_LIFECYCLE_EXPORTS = [
  "wasi_module_init",
  "wasi_module_start",
] as const;

export type WasiPreview1ExportName = (typeof WASI_PREVIEW1_EXPORTS)[number];

export interface WasiModuleExports {
  wasi_module_init: (
    channelOffset: number,
    argvPtr: number,
    argvCount: number,
    argvBytes: number,
    envPtr: number,
    envCount: number,
    envBytes: number,
  ) => number;
  wasi_module_start: () => number;
  [name: string]: WebAssembly.ExportValue;
}

/**
 * Shadow stack for the WASI module's own Rust frames.
 *
 * The dylink `mem_size` covers static data + BSS only; the imported
 * `__stack_pointer` needs a separate host-provided region. The module keeps no
 * buffers of its own -- every scratch region it uses is the syscall channel's
 * data area -- so its deepest frame is the 512-byte chunk in `copy_within`
 * plus a handful of small structs. 256 KiB is roughly five hundred times that
 * and still a quarter of what the fork-module reserves for its continuation
 * codec. It is deliberately not the 64 KiB wasm default: wasm has no guard
 * page, so a shadow-stack overflow silently corrupts BSS rather than trapping.
 */
const WASI_MODULE_SHADOW_STACK_BYTES = 1 << 18;

export interface InstantiateWasiModuleOptions {
  /** The compiled `wasi_module32.wasm` side module. */
  module: WebAssembly.Module;
  /** The guest's shared linear memory. */
  memory: WebAssembly.Memory;
  /** Guest pointer width: 4 for wasm32, 8 for wasm64. */
  ptrWidth: 4 | 8;
  /**
   * Reserve `size` bytes in the shared linear memory and return the base
   * offset. Production supplies the channel `mmap`; tests supply a bump
   * allocator.
   */
  reserve: (size: number) => number;
  /** Diagnostic label (e.g. `pid=NN`). */
  label: string;
  /** The process's argv, as the host received it. */
  argv: readonly string[];
  /** The process's environment, as `KEY=value` strings. */
  env: readonly string[];
}

export interface WasiModuleInstance {
  instance: WebAssembly.Instance;
  exports: WasiModuleExports;
  /** First byte of the host-reserved region (== `__memory_base`). */
  memoryBase: number;
  /** Total reserved bytes: static/BSS, the argv/env blobs, and the stack. */
  regionBytes: number;
  /** Guest address of the NUL-separated argv blob. */
  argvBase: number;
  /** Number of argv strings. */
  argvCount: number;
  /** Byte length of the argv blob, including every NUL terminator. */
  argvBytes: number;
  /** Guest address of the NUL-separated environment blob. */
  envBase: number;
  /** Number of environment strings. */
  envCount: number;
  /** Byte length of the environment blob, including every NUL terminator. */
  envBytes: number;
  /** The module's own (empty) indirect function table. */
  table: WebAssembly.Table;
  /**
   * The `wasi_snapshot_preview1` import namespace to hand the guest.
   *
   * Every member is the module's own export except `proc_exit`, which is
   * wrapped -- see `WasiExit`.
   */
  wasiImports: Record<string, WebAssembly.ExportValue>;
}

/**
 * Thrown by the `proc_exit` thunk to unwind the guest out of `_start`.
 *
 * Unwinding is a host act. The module issues `SYS_EXIT` and returns normally;
 * only the host can abandon the JavaScript call into `_start`. The two
 * alternatives -- trapping out of the module, or minting a wasm exception tag
 * -- both turn a normal process exit into something noisier for no gain on a
 * path taken exactly once per process.
 */
export class WasiExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`WASI proc_exit(${code})`);
    this.name = "WasiExit";
    this.code = code;
  }
}

/**
 * Encode a string list as the NUL-separated blob the module walks.
 *
 * The TypeScript shim held argv/env as JavaScript `string[]` and re-encoded
 * them on every `args_get`. The module has no allocator and no `TextEncoder`,
 * so the host writes the bytes once and passes their location. That is one
 * UTF-8 round trip removed, not merely relocated.
 */
function encodeStringBlob(values: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = values.map((value) => encoder.encode(value));
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const blob = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    blob.set(part, cursor);
    cursor += part.length;
    blob[cursor] = 0;
    cursor += 1;
  }
  return blob;
}

export function instantiateWasiModule(
  options: InstantiateWasiModuleOptions,
): WasiModuleInstance {
  const { module, memory, ptrWidth, reserve, label, argv, env } = options;
  const memInfo = readSideModuleMemInfo(module, `${label}: wasi-module`);

  const argvBlob = encodeStringBlob(argv);
  const envBlob = encodeStringBlob(env);

  const staticBytes = alignUp(memInfo.memorySize, memInfo.memoryAlignBytes);
  // Layout of the reserved region (low -> high):
  //   [memoryBase, +staticBytes)   static data + BSS
  //   [.., +argvBlob.length)       argv blob, NUL-separated
  //   [.., +envBlob.length)        env blob, NUL-separated
  //   [.., +SHADOW_STACK_BYTES)    shadow stack (grows down from the top)
  //
  // The blobs live inside the module's own region rather than in a second
  // allocation because they have exactly the module's lifetime: the guest may
  // call `args_get` at any point until it exits.
  const blobBytes = alignUp(argvBlob.length + envBlob.length, 16);
  const regionBytes = staticBytes + blobBytes + WASI_MODULE_SHADOW_STACK_BYTES;

  const memoryBase = reserve(regionBytes);
  const placement = placeSideModule({
    memInfo,
    memory,
    ptrWidth,
    memoryBase,
    regionBytes,
    label: `${label}: wasi-module`,
  });

  const argvBase = memoryBase + staticBytes;
  const envBase = argvBase + argvBlob.length;

  // The module declares table_size = 0, so it never adds entries. Give it its
  // own empty table rather than coupling it to any guest table.
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });

  const imports: WebAssembly.Imports = {
    env: {
      memory,
      __indirect_function_table: table,
      __memory_base: placement.memoryBaseGlobal,
      __table_base: placement.tableBaseGlobal,
      __stack_pointer: placement.stackPointerGlobal,
    },
  };

  // Synchronous instantiation runs the module's data-reloc start, which copies
  // its passive segments to `__memory_base + offset`. Fail loud here, never
  // later.
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, imports);
  } catch (error) {
    throw new Error(
      `${label}: wasi-module instantiation failed: ${String(error)}`,
    );
  }

  const exports = instance.exports as unknown as WasiModuleExports;
  const missing = [
    ...WASI_PREVIEW1_EXPORTS,
    ...WASI_MODULE_LIFECYCLE_EXPORTS,
  ].filter((name) => typeof exports[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `${label}: wasi-module is missing required exports: ${missing.join(", ")}`,
    );
  }

  // The blobs are written AFTER instantiation: the module's data-reloc start
  // writes its own static segments into the low part of the region, and a blob
  // written first could be overwritten by it.
  if (argvBlob.length > 0) {
    new Uint8Array(memory.buffer, argvBase, argvBlob.length).set(argvBlob);
  }
  if (envBlob.length > 0) {
    new Uint8Array(memory.buffer, envBase, envBlob.length).set(envBlob);
  }

  const wasiImports: Record<string, WebAssembly.ExportValue> = {};
  for (const name of WASI_PREVIEW1_EXPORTS) {
    wasiImports[name] = exports[name]!;
  }
  // The one wrapped member. See `WasiExit`.
  const moduleProcExit = exports.proc_exit as unknown as (code: number) => void;
  wasiImports.proc_exit = ((code: number): never => {
    moduleProcExit(code);
    throw new WasiExit(code);
  }) as unknown as WebAssembly.ExportValue;

  return {
    instance,
    exports,
    memoryBase,
    regionBytes,
    argvBase,
    argvCount: argv.length,
    argvBytes: argvBlob.length,
    envBase,
    envCount: env.length,
    envBytes: envBlob.length,
    table,
    wasiImports,
  };
}

/**
 * Seed the module with the channel and the argv/env blob locations, then open
 * its `/` preopen.
 *
 * Two calls rather than one because `wasi_module_start` issues a syscall: the
 * host must instantiate the module before the guest (the guest imports its
 * exports) but only opens the preopen once it is willing to block on the
 * channel. A failed root open is reported here rather than leaving the guest
 * apparently filesystem-less.
 */
export function startWasiModule(
  wasiModule: WasiModuleInstance,
  options: { channelOffset: number; label: string },
): void {
  const { channelOffset, label } = options;
  const initErrno = wasiModule.exports.wasi_module_init(
    channelOffset,
    wasiModule.argvBase,
    wasiModule.argvCount,
    wasiModule.argvBytes,
    wasiModule.envBase,
    wasiModule.envCount,
    wasiModule.envBytes,
  );
  if (initErrno !== 0) {
    throw new Error(
      `${label}: wasi_module_init failed with WASI errno ${initErrno}`,
    );
  }
  const startErrno = wasiModule.exports.wasi_module_start();
  if (startErrno !== 0) {
    throw new Error(
      `${label}: wasi-module could not open the '/' preopen ` +
        `(WASI errno ${startErrno})`,
    );
  }
}
