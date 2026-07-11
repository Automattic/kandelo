/**
 * Kernel worker entry points.
 *
 * Programs compiled with channel_syscall.c run in Worker threads.
 * All syscalls go through a shared-memory channel to the
 * CentralizedKernelWorker on the main thread.
 */
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import { DynamicLinker, type LoadedSharedLibrary } from "./dylink";
import { extractAbiVersion } from "./constants";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_IDLE,
  CHANNEL_STATUS_PENDING,
  CH_ARG_SIZE,
  CH_ARGS,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  HOST_INTERCEPTED_SYSCALLS,
} from "./generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "./process-memory";
// WASI detection helpers are tiny and live in their own file so we can
// import them eagerly without dragging in the 1300-line WasiShim class.
// The shim itself is dynamically imported below, only when a worker
// actually needs to host a wasi_snapshot_preview1 module — which our
// native channel-syscall binaries (mariadbd, dinit, dash, coreutils,
// everything compiled by wasm32-posix) never trigger.
import { isWasiModule, wasiModuleDefinesMemory } from "./wasi-detect";
export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

function alignUp(value: number, align: number): number {
  return Math.ceil(value / align) * align;
}

const SYS_MMAP_NR = ABI_SYSCALLS.Mmap;
const PROT_READ_WRITE = 3;
const MAP_PRIVATE_ANONYMOUS = 0x22;

/**
 * Build kernel.* import stubs for channel-mode Wasm modules.
 * Both process and thread workers need these because the musl overlay CRT
 * imports kernel.* functions for argc/argv, environ, fork state, and clone.
 *
 * On wasm64, pointer params arrive as BigInt (i64). The helper `n()` converts
 * BigInt|number → number for memory access (all addresses < 4GB).
 */
type KernelImports = Record<string, WebAssembly.ExportValue> & {
  kernel_exit: (status: number) => void;
  kernel_fork: (...args: unknown[]) => number;
};

function buildKernelImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  argv?: string[],
  envVars?: string[],
  onKernelExit?: (status: number) => void,
): KernelImports {
  const _argv = argv || [];
  const _envVars = envVars || [];
  const encoder = new TextEncoder();
  /** Convert wasm64 BigInt pointer to number (safe since addresses < 4GB) */
  const n = (v: number | bigint): number => typeof v === "bigint" ? Number(v) : v;

  return {
    // CRT argv support
    kernel_get_argc: (): number => _argv.length,
    kernel_argv_read: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      if (index >= _argv.length) return 0;
      const encoded = encoder.encode(_argv[index]);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, n(bufPtr), len).set(encoded.subarray(0, len));
      return len;
    },

    // CRT environ support
    kernel_environ_count: (): number => _envVars.length,
    kernel_environ_get: (index: number, bufPtr: number | bigint, bufMax: number): number => {
      if (index >= _envVars.length) return -1;
      const encoded = encoder.encode(_envVars[index]);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, n(bufPtr), len).set(encoded.subarray(0, len));
      return len;
    },

    // Fork/exec state — not a fork child.
    kernel_is_fork_child: (): number => 0,
    kernel_apply_fork_fd_actions: (): number => 0,
    kernel_get_fork_exec_path: (_buf: number | bigint, _max: number): number => 0,
    kernel_get_fork_exec_argc: (): number => 0,
    kernel_get_fork_exec_argv: (_index: number, _buf: number | bigint, _max: number): number => 0,
    kernel_push_argv: (_ptr: number | bigint, _len: number): void => {},
    kernel_clear_fork_exec: (): number => 0,

    // Exec dispatches through channel
    kernel_execve: (_pathPtr: number | bigint): number => -38, // ENOSYS

    // Exit dispatches through channel (SYS_EXIT)
    kernel_exit: (status: number): void => {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setBigInt64(base + CH_ARGS, BigInt(status), true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait for complete, then trap
      while (Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* */ }
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);
      onKernelExit?.(status);
    },

    // Clone dispatches through channel (SYS_CLONE)
    kernel_clone: (fnPtr: number | bigint, stackPtr: number | bigint, flags: number,
      arg: number | bigint, ptidPtr: number | bigint, tlsPtr: number | bigint, ctidPtr: number | bigint): number => {
      const SYS_CLONE_NR = ABI_SYSCALLS.Clone;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, SYS_CLONE_NR, true);
      view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, BigInt(flags), true);
      view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(stackPtr), true);
      view.setBigInt64(base + CH_ARGS + 2 * CH_ARG_SIZE, BigInt(ptidPtr), true);
      view.setBigInt64(base + CH_ARGS + 3 * CH_ARG_SIZE, BigInt(tlsPtr), true);
      view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, BigInt(ctidPtr), true);
      view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);
      // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
      view.setUint32(base + CH_DATA, n(fnPtr), true);
      view.setUint32(base + CH_DATA + 4, n(arg), true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      while (Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* */ }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

      if (err) return -err;
      return result;
    },

    // Fork dispatches through channel (SYS_FORK)
    kernel_fork: (): number => {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, HOST_INTERCEPTED_SYSCALLS.SYS_FORK, true);
      for (let i = 0; i < 6; i++) view.setBigInt64(base + CH_ARGS + i * CH_ARG_SIZE, 0n, true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      while (Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* */ }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

      if (err) return -err;
      return result;
    },
  };
}

export interface DlopenSupport {
  imports: Record<string, WebAssembly.ExportValue>;
  /** Replay the parent's dlopen list (read from the archive in linear
   *  memory). No-op if the archive head pointer is 0. Call this in the
   *  fork-child path AFTER setupChannelBase and BEFORE the wpk_fork
   *  rewind into _start. */
  replayDlopens: () => void;
}

/**
 * Build dlopen host imports for a process. These are called directly from
 * the user program's dlopen/dlsym/dlclose C stubs (libc/glue/dlopen.c).
 *
 * The DynamicLinker is lazily created on first use since most programs
 * don't use dlopen.
 *
 * Each successful dlopen is also persisted into a per-process archive
 * (linked list in linear memory, head pointer at a fixed slot below
 * forkBufAddr) so the fork child can replay them via `replayDlopens`.
 */
function buildDlopenImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  forkBufAddr: number,
  getTable: () => WebAssembly.Table | undefined,
  getStackPointer: () => WebAssembly.Global | undefined,
  getInstance: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8,
): DlopenSupport {
  let linker: DynamicLinker | null = null;
  const loadedLibraries = new Map<string, LoadedSharedLibrary>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const n = (v: number | bigint): number => typeof v === "bigint" ? Number(v) : v;

  const headOffset = ptrWidth === 8 ? DLOPEN_HEAD_OFFSET_WASM64 : DLOPEN_HEAD_OFFSET_WASM32;
  const headSlot = forkBufAddr - headOffset;
  const entrySize = ptrWidth === 8 ? DLOPEN_ENTRY_SIZE_WASM64 : DLOPEN_ENTRY_SIZE_WASM32;

  const readPtr = (view: DataView, addr: number): number =>
    ptrWidth === 8 ? Number(view.getBigUint64(addr, true)) : view.getUint32(addr, true);
  const writePtr = (view: DataView, addr: number, value: number): void => {
    if (ptrWidth === 8) view.setBigUint64(addr, BigInt(value), true);
    else view.setUint32(addr, value, true);
  };

  // The kernel mmap allocator. Shared with the linker, but also used
  // directly by persistArchiveEntry to obtain blocks for the archive.
  const allocateMemory = (size: number, align: number): number => {
    const requested = size + Math.max(align, 1) - 1;
    const view = new DataView(memory.buffer);
    const base = channelOffset;
    view.setInt32(base + CH_SYSCALL, SYS_MMAP_NR, true);
    view.setBigInt64(base + CH_ARGS + 0 * CH_ARG_SIZE, 0n, true);
    view.setBigInt64(base + CH_ARGS + 1 * CH_ARG_SIZE, BigInt(requested), true);
    view.setBigInt64(base + CH_ARGS + 2 * CH_ARG_SIZE, BigInt(PROT_READ_WRITE), true);
    view.setBigInt64(base + CH_ARGS + 3 * CH_ARG_SIZE, BigInt(MAP_PRIVATE_ANONYMOUS), true);
    view.setBigInt64(base + CH_ARGS + 4 * CH_ARG_SIZE, -1n, true);
    view.setBigInt64(base + CH_ARGS + 5 * CH_ARG_SIZE, 0n, true);

    const i32 = new Int32Array(memory.buffer);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
    Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
    while (Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* wait for mmap */ }

    const result = Number(view.getBigInt64(base + CH_RETURN, true));
    const err = view.getUint32(base + CH_ERRNO, true);
    Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

    if (err || result < 0) {
      throw new Error(`dlopen: mmap(${requested}) failed errno=${err || -result}`);
    }
    return alignUp(n(result), Math.max(align, 1));
  };

  const getLinker = (): DynamicLinker => {
    if (linker) return linker;
    const table = getTable();
    const sp = getStackPointer();
    if (!table || !sp) throw new Error("dlopen: program has no table or stack pointer");

    // Register main program's exported functions and data globals as global
    // symbols so shared libraries can resolve references to libc, libphp, etc.
    // Many libc helpers (e.g. __sigsetjmp_save, __errno_location) are __-
    // prefixed by convention but still need to be visible to side modules.
    // RESERVED names are handled per-module by the dylink env Proxy and must
    // not be shadowed by main exports.
    const RESERVED = new Set([
      "memory", "__indirect_function_table",
      "__memory_base", "__table_base", "__stack_pointer",
    ]);
    const globalSymbols = new Map<string, Function | WebAssembly.Global>();
    const inst = getInstance();
    if (inst) {
      for (const [name, exp] of Object.entries(inst.exports)) {
        if (RESERVED.has(name)) continue;
        if (typeof exp === "function" || exp instanceof WebAssembly.Global) {
          globalSymbols.set(name, exp);
        }
      }
    }

    linker = new DynamicLinker({
      memory,
      table,
      stackPointer: sp,
      allocateMemory,
      globalSymbols,
      got: new Map(),
      loadedLibraries,
    });
    return linker;
  };

  // Append an entry to the linked-list archive in linear memory. Each
  // entry is one mmap block: struct, then name UTF-8 (padded to 8-byte
  // alignment), then the side-module wasm bytes. Pointers are absolute
  // — fork's memcpy preserves the parent's address space.
  const persistArchiveEntry = (name: string, bytes: Uint8Array, memoryBase: number): void => {
    const nameBytes = encoder.encode(name);
    const nameLen = nameBytes.length;
    const nameAligned = (nameLen + 7) & ~7;
    const totalSize = entrySize + nameAligned + bytes.length;

    const entry = allocateMemory(totalSize, 8);
    const namePtr = entry + entrySize;
    const bytesPtr = namePtr + nameAligned;

    const view = new DataView(memory.buffer);
    if (ptrWidth === 8) {
      view.setBigUint64(entry + 0, 0n, true);
      view.setBigUint64(entry + 8, BigInt(namePtr), true);
      view.setBigUint64(entry + 16, BigInt(nameLen), true);
      view.setBigUint64(entry + 24, BigInt(bytesPtr), true);
      view.setBigUint64(entry + 32, BigInt(bytes.length), true);
      view.setBigUint64(entry + 40, BigInt(memoryBase), true);
    } else {
      view.setUint32(entry + 0, 0, true);
      view.setUint32(entry + 4, namePtr, true);
      view.setUint32(entry + 8, nameLen, true);
      view.setUint32(entry + 12, bytesPtr, true);
      view.setUint32(entry + 16, bytes.length, true);
      view.setUint32(entry + 20, memoryBase, true);
    }

    new Uint8Array(memory.buffer, namePtr, nameLen).set(nameBytes);
    new Uint8Array(memory.buffer, bytesPtr, bytes.length).set(bytes);

    // Append to tail (preserves insertion order).
    const head = readPtr(view, headSlot);
    if (head === 0) {
      writePtr(view, headSlot, entry);
      return;
    }
    let cursor = head;
    for (;;) {
      const next = readPtr(view, cursor);
      if (next === 0) {
        writePtr(view, cursor, entry);
        return;
      }
      cursor = next;
    }
  };

  const replayDlopens = (): void => {
    const view = new DataView(memory.buffer);
    let cursor = readPtr(view, headSlot);
    if (cursor === 0) return;

    // Force linker creation: it's lazily built on the first C-side
    // __wasm_dlopen call, which the fork child hasn't made yet. We need
    // it now to drive replay before _start resumes.
    const lk = getLinker();

    while (cursor !== 0) {
      let next: number, namePtr: number, nameLen: number, bytesPtr: number, bytesLen: number, memoryBase: number;
      if (ptrWidth === 8) {
        next = Number(view.getBigUint64(cursor + 0, true));
        namePtr = Number(view.getBigUint64(cursor + 8, true));
        nameLen = Number(view.getBigUint64(cursor + 16, true));
        bytesPtr = Number(view.getBigUint64(cursor + 24, true));
        bytesLen = Number(view.getBigUint64(cursor + 32, true));
        memoryBase = Number(view.getBigUint64(cursor + 40, true));
      } else {
        next = view.getUint32(cursor + 0, true);
        namePtr = view.getUint32(cursor + 4, true);
        nameLen = view.getUint32(cursor + 8, true);
        bytesPtr = view.getUint32(cursor + 12, true);
        bytesLen = view.getUint32(cursor + 16, true);
        memoryBase = view.getUint32(cursor + 20, true);
      }

      // Copy name + bytes out of shared memory before passing to
      // WebAssembly / TextDecoder — some engines reject SAB-backed
      // views, and we already pay the bytes copy cost on the parent's
      // initial dlopen path.
      const name = decoder.decode(
        new Uint8Array(new Uint8Array(memory.buffer, namePtr, nameLen)),
      );
      const bytesCopy = new Uint8Array(new Uint8Array(memory.buffer, bytesPtr, bytesLen));

      // DynamicLinker.dlopenSync returns 0 on error, >0 on success.
      const handle = lk.dlopenSync(name, bytesCopy, { memoryBase });
      if (handle === 0) {
        throw new Error(`dlopen(${name}): ${lk.dlerror() || "unknown"}`);
      }

      cursor = next;
    }
  };

  const imports: Record<string, WebAssembly.ExportValue> = {
    __wasm_dlopen: (bytesPtr: number, bytesLen: number,
                    namePtr: number, nameLen: number): number => {
      const bytes = new Uint8Array(memory.buffer, bytesPtr, bytesLen);
      // Copy bytes since memory.buffer may detach during Wasm instantiation
      const bytesCopy = new Uint8Array(bytes);
      // TextDecoder.decode() rejects views backed by SharedArrayBuffer
      // in Firefox (and recent Chrome), so copy the name bytes through
      // a non-shared Uint8Array before decoding. Same shape as
      // bytesCopy above.
      const nameBytesView = new Uint8Array(memory.buffer, namePtr, nameLen);
      const nameBytesCopy = new Uint8Array(nameBytesView);
      const name = decoder.decode(nameBytesCopy);
      const handle = getLinker().dlopenSync(name, bytesCopy);
      if (handle > 0) {
        // The linker just instantiated this — the map MUST contain it.
        // A miss means the shared-map ref got rewired and replay would
        // silently see an empty archive after fork; fail loudly here
        // instead of corrupting the fork child later.
        const loaded = loadedLibraries.get(name);
        if (!loaded) {
          throw new Error(`__wasm_dlopen(${name}): handle=${handle} but loadedLibraries lookup failed`);
        }
        persistArchiveEntry(name, bytesCopy, loaded.memoryBase);
      }
      return handle;
    },

    __wasm_dlsym: (handle: number, namePtr: number, nameLen: number): number => {
      // See __wasm_dlopen above: copy off the shared buffer before
      // TextDecoder.decode() touches it.
      const nameBytesView = new Uint8Array(memory.buffer, namePtr, nameLen);
      const nameBytesCopy = new Uint8Array(nameBytesView);
      const name = decoder.decode(nameBytesCopy);
      const result = getLinker().dlsym(handle, name);
      return result === null ? 0 : (result as number);
    },

    __wasm_dlclose: (handle: number): number => {
      return getLinker().dlclose(handle);
    },

    __wasm_dlerror: (bufPtr: number, bufMax: number): number => {
      const err = getLinker().dlerror();
      if (!err) return 0;
      const encoded = encoder.encode(err);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
      return len;
    },
  };

  return { imports, replayDlopens };
}

/**
 * Build import object for a Wasm module, stubbing unresolved imports.
 */
function buildImportObject(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  kernelImports: Record<string, WebAssembly.ExportValue>,
  channelOffset: number,
  dlopenImports?: Record<string, WebAssembly.ExportValue>,
  getInstance?: () => WebAssembly.Instance | undefined,
  ptrWidth: 4 | 8 = 4,
): WebAssembly.Imports {
  const envImports: Record<string, WebAssembly.ExportValue> = { memory };
  /** Convert wasm64 BigInt pointer to number (safe since addresses < 4GB) */
  const n = (v: number | bigint): number => typeof v === "bigint" ? Number(v) : v;
  /** Wrap a number as the correct return type for pointer-returning imports */
  const retPtr = (v: number): number | bigint => ptrWidth === 8 ? BigInt(v) : v;

  // Provide __channel_base as a mutable wasm global if the module imports it.
  // Each instance gets its own global, immune to cross-thread shared memory corruption.
  // On wasm64, __channel_base is i64 (BigInt); on wasm32 it's i32 (number).
  const moduleImports = WebAssembly.Module.imports(module);
  if (moduleImports.some(i => i.module === "env" && i.name === "__channel_base" && i.kind === "global")) {
    if (ptrWidth === 8) {
      envImports.__channel_base = new WebAssembly.Global({ value: "i64", mutable: true }, BigInt(channelOffset));
    } else {
      envImports.__channel_base = new WebAssembly.Global({ value: "i32", mutable: true }, channelOffset);
    }
  }

  // llvm/lld ≥22 emit __c_longjmp as a tag import for setjmp users; instantiation fails silently without it.
  if (moduleImports.some(i => i.module === "env" && i.name === "__c_longjmp" && (i.kind as string) === "tag")) {
    const Tag = (WebAssembly as typeof WebAssembly & {
      Tag?: new (descriptor: { parameters: string[] }) => WebAssembly.Tag;
    }).Tag;
    if (Tag) {
      envImports.__c_longjmp = new Tag({ parameters: ["i32"] }) as unknown as WebAssembly.ExportValue;
    }
  }

  // Add dlopen imports if provided
  if (dlopenImports) {
    Object.assign(envImports, dlopenImports);
  }

  // C++ operator new/delete fallbacks — delegate to the wasm instance's malloc/free.
  // Normally resolved by MariaDB's my_new.cc (USE_MYSYS_NEW), but kept as safety net.
  if (getInstance) {
    const cppMalloc = (size: number | bigint): number | bigint => {
      const inst = getInstance();
      const malloc = inst?.exports.malloc as ((n: number | bigint) => number | bigint) | undefined;
      if (!malloc) return ptrWidth === 8 ? 0n : 0;
      return malloc(size || (ptrWidth === 8 ? 1n : 1));
    };
    const cppFree = (ptr: number | bigint): void => {
      const inst = getInstance();
      const free = inst?.exports.free as ((p: number | bigint) => void) | undefined;
      if (free) free(ptr);
    };
    envImports._Znwm = cppMalloc;            // operator new(size_t)
    envImports._Znam = cppMalloc;            // operator new[](size_t)
    envImports._ZdlPv = cppFree;             // operator delete(void*)
    envImports._ZdlPvm = cppFree;            // operator delete(void*, size_t)
    envImports._ZdaPv = cppFree;             // operator delete[](void*)
    envImports._ZdaPvm = cppFree;            // operator delete[](void*, size_t)
    envImports._ZnwmRKSt9nothrow_t = cppMalloc; // operator new(size_t, nothrow)
    envImports._ZnamRKSt9nothrow_t = cppMalloc; // operator new[](size_t, nothrow)
  }

  // C++ runtime stubs — libc++/libc++abi functions that may be imported when
  // the wasm binary links against empty stub archives.
  // __cxa_guard_acquire/release: thread-safe static initialization.
  // Wasm is single-threaded per instance so no real locking needed.
  envImports.__cxa_guard_acquire = (guardPtr: number | bigint): number => {
    const view = new Uint8Array(memory.buffer);
    if (view[n(guardPtr)]) return 0; // already initialized
    return 1; // needs initialization
  };
  envImports.__cxa_guard_release = (guardPtr: number | bigint): void => {
    const view = new Uint8Array(memory.buffer);
    view[n(guardPtr)] = 1; // mark initialized
  };
  envImports.__cxa_guard_abort = (_guardPtr: number | bigint): void => { /* no-op */ };
  envImports.__cxa_pure_virtual = (): void => {
    throw new Error("pure virtual method called");
  };
  envImports.__cxa_atexit = (): number => 0; // no-op, return success
  envImports.__cxa_thread_atexit = (): number => 0; // no-op, return success

  // libc++ verbose abort — called on internal library errors
  envImports._ZNSt3__122__libcpp_verbose_abortEPKcz = (_fmt: number | bigint, _args: number | bigint): void => {
    throw new Error("libc++ verbose abort");
  };

  // libc++ sort — MariaDB doesn't actually call this at runtime
  // (linked from empty stub libc++.a). Signature: sort<less<ull>, ull*>(first, last, comp)
  envImports["_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_"] = (_first: number | bigint, _last: number | bigint, _comp: number | bigint): void => {
    throw new Error("libc++ sort called unexpectedly");
  };
  const dcTiClassCache = new Map<number, number>(); // typeinfo addr → metaclass (0=leaf, 1=SI, 2=VMI)
  // __dynamic_cast: Itanium C++ ABI dynamic_cast implementation.
  // Reads RTTI from the object's vtable and walks the type hierarchy to
  // check if dst_type is reachable from the object's runtime type.
  // Args: (src_ptr, src_typeinfo*, dst_typeinfo*, src2dst_hint)
  envImports.__dynamic_cast = (srcPtr_: number | bigint, _srcType: number | bigint, dstType_: number | bigint, _src2dst: number | bigint): number | bigint => {
    const srcPtr = n(srcPtr_);
    const dstType = n(dstType_);
    if (srcPtr === 0) return retPtr(0);
    const view = new DataView(memory.buffer);
    const memSize = memory.buffer.byteLength;
    const PS = ptrWidth; // pointer size in bytes
    const readPtr = (addr: number): number =>
      PS === 8 ? Number(view.getBigUint64(addr, true)) : view.getUint32(addr, true);
    const readSPtr = (addr: number): number =>
      PS === 8 ? Number(view.getBigInt64(addr, true)) : view.getInt32(addr, true);

    // Read vtable pointer from object (Itanium ABI: first word is vtable ptr)
    const vtablePtr = readPtr(srcPtr);
    if (vtablePtr === 0 || vtablePtr >= memSize) return retPtr(0);

    // Itanium ABI vtable layout:
    //   vtable[-PS*2] = offset_to_top (ptrdiff_t)
    //   vtable[-PS]   = RTTI pointer (typeinfo*)
    //   vtable[0]     = first virtual function
    if (vtablePtr < 2 * PS) return retPtr(0);
    const rttiPtr = readPtr(vtablePtr - PS);
    if (rttiPtr === 0 || rttiPtr >= memSize) return retPtr(0);
    const offsetToTop = readSPtr(vtablePtr - 2 * PS);

    // Direct match: runtime type IS the destination type
    if (rttiPtr === dstType) return retPtr(srcPtr + offsetToTop);

    // Walk the type hierarchy from the runtime type, checking if dstType
    // is a base class. typeinfo layout (pointer-sized fields):
    //   [0]      vtable ptr (for the typeinfo meta-class)
    //   [PS]     name ptr (mangled type name)
    //   -- __si_class_type_info adds:
    //   [2*PS]   base typeinfo ptr
    //   -- __vmi_class_type_info adds:
    //   [2*PS]   flags (uint32)
    //   [2*PS+4] base_count (uint32)
    //   [2*PS+8 + i*(PS+4)] base_info[i].base_type (ptr)
    //   [2*PS+8 + i*(PS+4) + PS] base_info[i].offset_flags (long)
    const TI_FIELD2 = 2 * PS; // offset of first field after (vtablePtr, namePtr)
    const BASE_INFO_STRIDE = PS + PS; // base_type(ptr) + offset_flags(long/ptr)

    const tiClassCache = dcTiClassCache;

    const isTypeAncestor = (ti: number, target: number, visited: Set<number>): boolean => {
      if (ti === target) return true;
      if (ti === 0 || ti >= memSize || visited.has(ti)) return false;
      visited.add(ti);

      if (ti + TI_FIELD2 + PS > memSize) return false;

      const cached = tiClassCache.get(ti);
      if (cached === 0) return false; // leaf
      if (cached === 1) {
        // SI: field at TI_FIELD2 is base typeinfo ptr
        const basePtr = readPtr(ti + TI_FIELD2);
        return isTypeAncestor(basePtr, target, visited);
      }
      if (cached === 2) {
        // VMI: flags(u32) + base_count(u32) then base_info array
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        for (let i = 0; i < baseCount; i++) {
          const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
          if (baseType > 0 && isTypeAncestor(baseType, target, visited)) return true;
        }
        return false;
      }

      // Not cached — classify by trying SI first, then VMI
      const field2 = readPtr(ti + TI_FIELD2);

      // Try SI: field2 is a pointer to another typeinfo
      if (field2 > 0x100 && field2 + PS <= memSize) {
        const possibleTiName = readPtr(field2 + PS);
        if (possibleTiName > 0 && possibleTiName < memSize) {
          tiClassCache.set(ti, 1);
          if (isTypeAncestor(field2, target, visited)) return true;
          tiClassCache.delete(ti);
        }
      }

      // Try VMI: field at TI_FIELD2 is flags (u32, 0-3), [TI_FIELD2+4] is base_count
      const flags32 = view.getUint32(ti + TI_FIELD2, true);
      if (flags32 <= 3 && ti + TI_FIELD2 + 8 <= memSize) {
        const baseCount = view.getUint32(ti + TI_FIELD2 + 4, true);
        if (baseCount > 0 && baseCount < 100 && ti + TI_FIELD2 + 8 + baseCount * BASE_INFO_STRIDE <= memSize) {
          tiClassCache.set(ti, 2);
          for (let i = 0; i < baseCount; i++) {
            const baseType = readPtr(ti + TI_FIELD2 + 8 + i * BASE_INFO_STRIDE);
            if (baseType > 0 && isTypeAncestor(baseType, target, visited)) return true;
          }
          return false;
        }
      }

      tiClassCache.set(ti, 0);
      return false;
    };

    if (isTypeAncestor(rttiPtr, dstType, new Set())) {
      return retPtr(srcPtr + offsetToTop);
    }
    return retPtr(0);
  };

  // libc++ sort specialization — sort uint64 array in-place
  envImports['_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_'] = (
    begin_: number | bigint, end_: number | bigint,
  ): void => {
    const begin = n(begin_), end = n(end_);
    const view = new DataView(memory.buffer);
    const count = (end - begin) / 8;
    const arr: bigint[] = [];
    for (let i = 0; i < count; i++) arr.push(view.getBigUint64(begin + i * 8, true));
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < count; i++) view.setBigUint64(begin + i * 8, arr[i], true);
  };

  // Stub any remaining unresolved function imports
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== "function") continue;
    if (imp.module === "env") {
      if (!envImports[imp.name]) {
        envImports[imp.name] = (..._args: unknown[]) => {
          throw new Error(`Unimplemented import: env.${imp.name}`);
        };
      }
    } else if (imp.module === "kernel") {
      if (!kernelImports[imp.name]) {
        kernelImports[imp.name] = (..._args: unknown[]) => 0;
      }
    }
  }

  const importObject: WebAssembly.Imports = { env: envImports };
  if (Object.keys(kernelImports).length > 0) {
    importObject.kernel = kernelImports;
  }
  return importObject;
}

/** Size of the fork save buffer used by wpk_fork_* instrumentation */
const FORK_BUF_SIZE = FORK_SAVE_BUFFER_SIZE;

// Slot below forkBufAddr that stores the head pointer of the dlopen
// archive linked list. Fork's memcpy carries the parent's archive into
// the child intact; the child walks it to replay each dlopen before
// wpk_fork rewind.
const DLOPEN_HEAD_OFFSET_WASM32 = 12;
const DLOPEN_HEAD_OFFSET_WASM64 = 24;
const DLOPEN_ENTRY_SIZE_WASM32 = 24;
const DLOPEN_ENTRY_SIZE_WASM64 = 48;

const WPK_FORK_EXPORTS = [
  "wpk_fork_unwind_begin",
  "wpk_fork_unwind_end",
  "wpk_fork_rewind_begin",
  "wpk_fork_rewind_end",
  "wpk_fork_state",
] as const;

function hasCompleteForkInstrumentation(
  moduleExports: WebAssembly.ModuleExportDescriptor[],
  pid: number,
): boolean {
  const exportNames = new Set(moduleExports.map((e) => e.name));
  const legacyAsyncifyExports = [...exportNames].filter((name) => name.startsWith("asyncify_"));
  if (legacyAsyncifyExports.length > 0) {
    throw new Error(
      `pid=${pid}: user program exports legacy Asyncify instrumentation ` +
        `(${legacyAsyncifyExports.join(", ")}). This host requires ` +
        "wasm-fork-instrument artifacts exporting wpk_fork_*; rebuild the package for the current ABI.",
    );
  }

  const presentWpkExports = WPK_FORK_EXPORTS.filter((name) => exportNames.has(name));
  if (presentWpkExports.length > 0 && presentWpkExports.length !== WPK_FORK_EXPORTS.length) {
    const missing = WPK_FORK_EXPORTS.filter((name) => !exportNames.has(name));
    throw new Error(
      `pid=${pid}: incomplete wasm-fork-instrument exports; missing ${missing.join(", ")}. ` +
        "Rebuild the package for the current ABI.",
    );
  }

  return presentWpkExports.length === WPK_FORK_EXPORTS.length;
}

/**
 * Verify that a user program was built against an ABI compatible with the
 * running kernel.
 *
 * Three outcomes:
 *   - Program exports `__abi_version` matching the kernel: silent pass.
 *   - Program exports `__abi_version` with a different value: hard error.
 *     A known mismatch is always worse than silent misbehavior — we would
 *     rather refuse to run.
 *   - Program doesn't export `__abi_version` at all: warn and continue.
 *     This is for rolling out the marker: legacy binaries built before
 *     channel_syscall.c gained the export don't have it. Once all
 *     published binaries carry the marker, this path can be flipped to
 *     a hard error — see docs/abi-versioning.md.
 *
 * Reads the marker directly from the Wasm bytes instead of calling the
 * `__abi_version` export. LLVM/lld may wrap exported functions with
 * `__wasm_call_ctors`; invoking the export here would run C++ constructors
 * before `_start`, which breaks runtimes such as SpiderMonkey.
 */
function verifyProgramAbi(
  programBytes: ArrayBuffer,
  expected: number | undefined,
  pid: number,
): void {
  if (expected === undefined) {
    // Older host driver didn't populate the field — skip silently.
    // Will be removed once all callers are updated.
    return;
  }
  const actual = extractAbiVersion(programBytes);
  if (actual === null) {
    if (!abiMissingWarned) {
      abiMissingWarned = true;
      console.warn(
        `[worker] pid=${pid}: user program lacks __abi_version export — ` +
          "legacy binary predates ABI marker rollout. Rebuild against the " +
          "current glue (channel_syscall.c) to pick up the check. " +
          "See docs/abi-versioning.md.",
      );
    }
    return;
  }
  if (actual !== expected) {
    throw new Error(
      `pid=${pid}: ABI version mismatch — kernel advertises ${expected}, ` +
        `user program built against ${actual}. Rebuild the program against the ` +
        "current kernel, or roll back the kernel to the matching version. " +
        "See docs/abi-versioning.md.",
    );
  }
}

/** Warn once per worker process, not once per program load. */
let abiMissingWarned = false;

/**
 * Main process worker entry point.
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  try {
    const { memory, programBytes, channelOffset, pid } = initData;
    const ptrWidth = initData.ptrWidth ?? 4;
    // Use pre-compiled module if provided (avoids recompilation in workers)
    const module = initData.programModule
      ? initData.programModule
      : await WebAssembly.compile(programBytes);
    // --- WASI module detection and handling ---
    if (isWasiModule(module)) {
      if (wasiModuleDefinesMemory(module)) {
        throw new Error(
          "WASI module defines its own memory. Only modules that import memory " +
          "(compiled with --import-memory) are supported.",
        );
      }

      // Lazy-import the heavy shim only when we actually have a WASI
      // module to host. Native channel-syscall workers (the common
      // case) skip this import entirely.
      const { WasiShim, WasiExit } = await import("./wasi-shim");

      const wasiShim = new WasiShim(
        memory, channelOffset, initData.argv || [], initData.env || [],
      );
      const wasiImports = wasiShim.getImports();

      // Build import object: provide wasi_snapshot_preview1 namespace + env.memory
      const importObject: WebAssembly.Imports = {
        wasi_snapshot_preview1: wasiImports as Record<string, WebAssembly.ExportValue>,
        env: { memory },
      };

      // Stub any additional env imports the module needs
      const moduleImports = WebAssembly.Module.imports(module);
      for (const imp of moduleImports) {
        if (imp.module === "env" && imp.name !== "memory") {
          if (!(importObject.env as Record<string, unknown>)[imp.name]) {
            (importObject.env as Record<string, unknown>)[imp.name] =
              imp.kind === "function"
                ? (..._args: unknown[]) => { throw new Error(`Unimplemented WASI env import: ${imp.name}`); }
                : undefined;
          }
        }
      }

      const instance = await WebAssembly.instantiate(module, importObject);

      // Initialize preopened directories
      wasiShim.init();

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run _start
      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
      } catch (e) {
        if (e instanceof WasiExit) {
          exitCode = e.code;
        } else {
          throw e;
        }
      }

      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
      return;
    }

    // --- SDK module path (existing) ---
    let kernelExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      initData.argv || [],
      initData.env || [],
      (status) => { kernelExitStatus = status; },
    );

    // Check if the module has complete wpk_fork_* instrumentation exports,
    // and reject stale legacy fork artifacts before they can run.
    const moduleExports = WebAssembly.Module.exports(module);
    const hasForkInstrumentation = hasCompleteForkInstrumentation(moduleExports, pid);
    // Fork state — captured by kernel_fork closure
    let forkResult = 0;
    const forkBufAddr = initData.forkBufAddr ?? channelOffset - FORK_BUF_SIZE;

    if (hasForkInstrumentation) {
      // Override kernel_fork with fork-instrumentation-aware version.
      // Late-bound: processInstance is set after instantiation.
      let processInstance: WebAssembly.Instance | null = null;

      kernelImports.kernel_fork = (): number => {
        if (!processInstance) return -38; // ENOSYS

        const getState = processInstance.exports.wpk_fork_state as () => number;
        const state = getState();
        if (state === 2) {
          // Rewinding: end rewind and return the stored fork result
          (processInstance.exports.wpk_fork_rewind_end as () => void)();
          return forkResult;
        }

        // Normal call: start unwind to save the call stack.
        // SYS_FORK is sent after _start returns (unwind complete).
        // wpk_fork_unwind_begin self-initializes current_pos and snapshots
        // saved_globals (including __tls_base and __stack_pointer) into the
        // buffer — the host no longer pre-seeds the header.
        (processInstance.exports.wpk_fork_unwind_begin as (addr: number) => void)(forkBufAddr);
        return 0; // ignored during unwind
      };

      // Build import object and instantiate
      const dlopenSupport = buildDlopenImports(
        memory,
        channelOffset,
        forkBufAddr,
        () => processInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined,
        () => processInstance?.exports.__stack_pointer as WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
        ptrWidth,
      );
      const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenSupport.imports,
        () => processInstance ?? undefined, ptrWidth);
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;
      verifyProgramAbi(programBytes, initData.kernelAbiVersion, pid);

      // For the fork-parent case (initial launch, not a fork child), install
      // __channel_base now — the parent's __tls_base is already correctly
      // populated by instantiation, so setupChannelBase can read it.
      //
      // For fork children: defer until AFTER wpk_fork_rewind_begin runs
      // (inside the loop below), because rewind_begin is what restores
      // the child's __tls_base from the fork save buffer; setupChannelBase
      // would otherwise see a zeroed __tls_base.
      if (!initData.isForkChild) {
        setupChannelBase(instance, module, memory, channelOffset, programBytes as ArrayBuffer, ptrWidth);
      }

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run with wpk_fork_* instrumentation
      let exitCode = 0;
      try {
        const start = instance.exports._start as () => void;
        const getState = instance.exports.wpk_fork_state as () => number;
        const unwindEnd = instance.exports.wpk_fork_unwind_end as () => void;
        const rewindBegin = instance.exports.wpk_fork_rewind_begin as (addr: number) => void;

        // For fork children: start with rewind to resume from fork point
        let needsRewind = !!initData.isForkChild;
        if (needsRewind) {
          forkResult = 0; // fork() returns 0 in child
        }

        // Use parent's fork buffer address for child rewind
        const rewindAddr = initData.isForkChild && initData.forkBufAddr != null
          ? initData.forkBufAddr
          : forkBufAddr;
        let replayedForkChildDlopens = false;

        // Choose entry: normal _start, or — for a fork-from-non-main-thread
        // child — call the parent thread's thread function directly. _start
        // is not in the thread's fork-path call chain, so rewinding through
        // it would never reach the saved fork() call site. The thread
        // function's instrumented body sees state==REWINDING on entry and
        // replays the saved frames back to fork().
        let entry: () => void;
        if (initData.isForkChild && initData.forkChildThreadFnPtr != null) {
          const table = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
          if (!table) {
            throw new Error("Fork-from-thread child: no __indirect_function_table export");
          }
          const fnIdx = initData.forkChildThreadFnPtr;
          const tableIdx = ptrWidth === 8 ? (BigInt(fnIdx) as unknown as number) : fnIdx;
          const threadFn = table.get(tableIdx) as ((arg: number | bigint) => unknown) | null;
          if (!threadFn) {
            throw new Error(`Fork-from-thread child: thread function at index ${fnIdx} is null`);
          }
          const childArgPtr = initData.forkChildThreadArgPtr ?? 0;
          const threadArg = ptrWidth === 8 ? BigInt(childArgPtr) : childArgPtr;
          entry = () => { threadFn(threadArg); };
        } else {
          entry = start;
        }

        for (;;) {
          if (needsRewind) {
            // wpk_fork_rewind_begin restores all saved mutable globals
            // (including __tls_base and __stack_pointer) from the fork
            // buffer. Must run before setupChannelBase, which reads
            // __tls_base to locate the channel-base TLS slot.
            rewindBegin(rewindAddr);
            // Now that rewind_begin has restored __tls_base, install
            // __channel_base for this (child) instance.
            setupChannelBase(instance, module, memory, channelOffset, programBytes as ArrayBuffer, ptrWidth);
            if (initData.isForkChild && !replayedForkChildDlopens) {
              try {
                dlopenSupport.replayDlopens();
              } catch (e) {
                throw new Error(`fork-replay-dlopen failed: ${e instanceof Error ? e.message : String(e)}`);
              }
              replayedForkChildDlopens = true;
            }
            needsRewind = false;
          }

          try {
            entry();
          } catch (e) {
            if (e instanceof Error && e.message.includes("unreachable")) {
              if (kernelExitStatus !== null) {
                exitCode = kernelExitStatus;
                break; // Normal exit via kernel_exit -> unreachable trap
              }
            }
            throw e;
          }

          const forkState = getState();
          if (forkState === 1) {
            // Unwind completed (fork) — finalize and send SYS_FORK.
            unwindEnd();

            // Send SYS_FORK through the channel now that memory has the
            // fork save buffer populated (saved_globals + frames).
            const childPid = sendForkSyscall(memory, channelOffset);
            if (childPid < 0) {
              throw new Error(`Fork failed: errno=${-childPid}`);
            }
            forkResult = childPid;
            needsRewind = true;
            continue;
          }

          // Normal return — program finished
          if (kernelExitStatus === null) {
            kernelImports.kernel_exit(0);
            exitCode = kernelExitStatus ?? 0;
          }
          break;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("unreachable") && kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        } else {
          throw e;
        }
      }

      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
    } else {
      // No fork instrumentation: fork cannot be represented safely because
      // the child cannot resume at the fork call site. Fail loudly if the
      // program reaches kernel_fork instead of silently degrading.
      kernelImports.kernel_fork = (): number => {
        throw new Error(
          `pid=${pid}: kernel_fork reached without complete wasm-fork-instrument ` +
            "exports. Rebuild the program with scripts/run-wasm-fork-instrument.sh.",
        );
      };

      let processInstance: WebAssembly.Instance | null = null;
      const dlopenSupport = buildDlopenImports(
        memory,
        channelOffset,
        forkBufAddr,
        () => processInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined,
        () => processInstance?.exports.__stack_pointer as WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
        ptrWidth,
      );
      const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenSupport.imports,
        () => processInstance ?? undefined, ptrWidth);
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;
      verifyProgramAbi(programBytes, initData.kernelAbiVersion, pid);

      setupChannelBase(instance, module, memory, channelOffset, programBytes as ArrayBuffer, ptrWidth);

      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
        if (kernelExitStatus !== null) {
          exitCode = kernelExitStatus;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("unreachable")) {
          if (kernelExitStatus !== null) {
            exitCode = kernelExitStatus;
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (kernelExitStatus === null) {
        kernelImports.kernel_exit(exitCode);
        exitCode = kernelExitStatus ?? exitCode;
      }

      if (exitCode === 0) {
        console.debug(`[worker] pid=${pid} _start() returned, exitCode=0`);
      } else {
        console.error(`[worker] pid=${pid} _start() returned, exitCode=${exitCode}`);
      }
      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
    }
  } catch (err) {
    let errMsg: string;
    if (err instanceof Error) {
      errMsg = `${err.message}\n${err.stack}`;
    } else if ((WebAssembly as any).Exception && err instanceof (WebAssembly as any).Exception) {
      // WebAssembly.Exception isn't an Error subclass in V8, so String(err)
      // produces the useless "[object WebAssembly.Exception]". Surface
      // anything we can read off it for build-time debugging.
      const wex = err as { message?: string; stack?: string };
      errMsg = `WebAssembly.Exception: ${wex.message ?? "<no message>"}\n${wex.stack ?? "<no stack>"}`;
    } else {
      errMsg = String(err);
    }
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Kernel worker failed: ${errMsg}`,
    } satisfies WorkerToHostMessage);
  }
}

/**
 * Set up __channel_base in TLS so __do_syscall knows the channel offset.
 */
/**
 * Detect __channel_base's TLS offset by inspecting the Wasm binary.
 *
 * The __get_channel_base_addr function has a simple body:
 *   i32.const <offset>
 *   global.get <__tls_base>
 *   i32.add
 *   return
 *
 * We find this function by looking at the export wrapper's call target.
 * Returns the i32.const value, or -1 if detection fails.
 */
function detectChannelBaseTlsOffset(programBytes: ArrayBuffer): number {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return -1;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0, shift = 0, pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  // Parse sections to find Export and Code sections
  interface Section { id: number; contentOffset: number; contentSize: number; }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    sections.push({ id: sectionId, contentOffset: offset + 1 + sizeBytes, contentSize: sectionSize });
    offset += 1 + sizeBytes + sectionSize;
  }

  // Count function imports (section 2)
  for (const sec of sections) {
    if (sec.id === 2) {
      let pos = sec.contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readLEB128(src, pos); pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readLEB128(src, pos); pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 0) { numFuncImports++; const [, n] = readLEB128(src, pos); pos += n; }
        else if (kind === 1) { pos++; const f = src[pos++]; const [, n] = readLEB128(src, pos); pos += n; if (f & 1) { const [, n2] = readLEB128(src, pos); pos += n2; } }
        else if (kind === 2) { const f = src[pos++]; const [, n] = readLEB128(src, pos); pos += n; if (f & 1) { const [, n2] = readLEB128(src, pos); pos += n2; } }
        else if (kind === 3) { pos += 2; }
      }
      break;
    }
  }

  // Find __get_channel_base_addr export
  let channelBaseExportFuncIdx = -1;
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos); pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos); pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen)); pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos); pos += idxBytes;
        if (kind === 0 && name === "__get_channel_base_addr") {
          channelBaseExportFuncIdx = idx;
          break;
        }
      }
      break;
    }
  }

  if (channelBaseExportFuncIdx < 0) return -1;

  // The export may be either:
  // 1. A direct export (no ctors): i32.const <offset>; global.get; i32.add; ...
  // 2. A wrapper: call __wasm_call_ctors; call <actual>; end
  const exportCodeEntry = channelBaseExportFuncIdx - numFuncImports;
  if (exportCodeEntry < 0) return -1;

  for (const sec of sections) {
    if (sec.id !== 10) continue;
    let pos = sec.contentOffset;
    const [, funcCountBytes] = readLEB128(src, pos); pos += funcCountBytes;

    // Skip to the exported function's body
    for (let i = 0; i < exportCodeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }
    const [, bodySizeBytes] = readLEB128(src, pos); pos += bodySizeBytes;
    // Skip locals
    const [localCount, lcBytes] = readLEB128(src, pos); pos += lcBytes;
    for (let i = 0; i < localCount; i++) { const [, n] = readLEB128(src, pos); pos += n; pos++; }

    // i32.const = 0x41, i64.const = 0x42 (wasm64 uses i64 for addresses)
    const I32_CONST = 0x41;
    const I64_CONST = 0x42;

    // Pattern 1: direct export — starts with i32.const/i64.const <offset>
    if (src[pos] === I32_CONST || src[pos] === I64_CONST) {
      pos++;
      const [tlsOffset] = readLEB128(src, pos);
      return tlsOffset;
    }

    // Pattern 3: instrumented/optimized — global.get <tls_base>; i32/i64.const <offset>; i32/i64.add
    if (src[pos] === 0x23) {
      let p3 = pos + 1;
      const [, globalIdxBytes] = readLEB128(src, p3); p3 += globalIdxBytes;
      if (src[p3] === I32_CONST || src[p3] === I64_CONST) {
        p3++;
        const [tlsOffset] = readLEB128(src, p3);
        return tlsOffset;
      }
    }

    // Pattern 2: wrapper — call <ctors>; call <actual>; end
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [, ctorIdxBytes] = readLEB128(src, pos); pos += ctorIdxBytes;
    if (src[pos] !== 0x10) return -1;
    pos++;
    const [actualFuncIdx] = readLEB128(src, pos);

    const actualCodeEntry = actualFuncIdx - numFuncImports;
    if (actualCodeEntry < 0) return -1;

    let pos2 = sec.contentOffset;
    const [, fcb2] = readLEB128(src, pos2); pos2 += fcb2;
    for (let i = 0; i < actualCodeEntry; i++) {
      const [bs, bsb] = readLEB128(src, pos2);
      pos2 += bsb + bs;
    }
    const [, bsb2] = readLEB128(src, pos2); pos2 += bsb2;
    const [lc2, lcb2] = readLEB128(src, pos2); pos2 += lcb2;
    for (let i = 0; i < lc2; i++) { const [, n] = readLEB128(src, pos2); pos2 += n; pos2++; }

    if (src[pos2] !== I32_CONST && src[pos2] !== I64_CONST) return -1;
    pos2++;
    const [tlsOffset] = readLEB128(src, pos2);
    return tlsOffset;
  }

  return -1;
}

function setupChannelBase(
  instance: WebAssembly.Instance,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  channelOffset: number,
  programBytes?: ArrayBuffer,
  ptrWidth: 4 | 8 = 4,
): void {
  // If the module imports env.__channel_base as a global, the channel offset was
  // already set at instantiation via WebAssembly.Global in buildImportObject.
  const moduleImports = WebAssembly.Module.imports(module);
  if (moduleImports.some(i => i.module === "env" && i.name === "__channel_base" && i.kind === "global")) {
    return;
  }

  // Legacy TLS-based approach: write channelOffset into the TLS slot.
  const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
  const view = new DataView(memory.buffer);
  const tlsAddr = tlsBase ? Number(tlsBase.value) : 0;

  if (tlsAddr > 0) {
    let detectedOffset = -1;
    if (programBytes) {
      detectedOffset = detectChannelBaseTlsOffset(programBytes);
    }
    const addr = tlsAddr + (detectedOffset >= 0 ? detectedOffset : 0);
    if (ptrWidth === 8) {
      view.setBigUint64(addr, BigInt(channelOffset), true);
    } else {
      view.setUint32(addr, channelOffset, true);
    }
  }
}

/**
 * Send SYS_FORK through the channel and wait for the result.
 * Returns child pid on success, or -errno on failure.
 */
function sendForkSyscall(memory: WebAssembly.Memory, channelOffset: number): number {
  const view = new DataView(memory.buffer);
  view.setInt32(channelOffset + CH_SYSCALL, HOST_INTERCEPTED_SYSCALLS.SYS_FORK, true);
  for (let i = 0; i < 6; i++) {
    view.setBigInt64(channelOffset + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  }

  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
  Atomics.notify(i32, (channelOffset + CH_STATUS) / 4, 1);
  while (Atomics.wait(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* */ }

  const result = Number(view.getBigInt64(channelOffset + CH_RETURN, true));
  const err = view.getUint32(channelOffset + CH_ERRNO, true);
  Atomics.store(i32, (channelOffset + CH_STATUS) / 4, CHANNEL_STATUS_IDLE);

  if (err) return -err;
  return result;
}

/**
 * Patch a Wasm binary for use in a thread instance (shared memory).
 *
 * In LLVM's shared-memory Wasm model:
 * - The Start function (section id=8) is `__wasm_init_memory` — it initializes
 *   passive data segments with an atomic guard. Threads must NOT re-run this.
 * - A separate constructor function (`__wasm_call_ctors`) runs C++ global
 *   constructors. LLVM inserts a `call` to this function at the beginning of
 *   every exported function. Threads must NOT re-run constructors either, as
 *   they would clobber shared global state (e.g. resetting LOGGER::file_log_handler
 *   to NULL in MariaDB).
 *
 * This function:
 * 1. Removes the Start section so `__wasm_init_memory` doesn't auto-run.
 * 2. Identifies `__wasm_call_ctors` only from authoritative linker evidence
 *    and replaces that function body with a no-op.
 *
 * `wasm-fork-instrument` deliberately preserves `__abi_version` in its raw
 * linker-wrapper form. When constructors exist, wasm-ld prefixes that wrapper
 * with `call $__wasm_call_ctors`; when they do not, the marker starts with its
 * constant return. This distinction is load-bearing. A large C binary can
 * have hundreds of unrelated exported call targets and no constructors at
 * all, so selecting a merely shared or first call target corrupts the module.
 */
export function patchWasmForThread(bytes: ArrayBuffer): ArrayBuffer {
  const src = new Uint8Array(bytes);
  if (src.length < 8) return bytes;

  function readLEB128(buf: Uint8Array, off: number): [number, number] {
    let result = 0;
    let shift = 0;
    let pos = off;
    for (;;) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return [result, pos - off];
  }

  function encodeLEB128(value: number): number[] {
    const result: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      result.push(byte);
    } while (value !== 0);
    return result;
  }

  function readName(pos: number): [string, number] {
    const [length, lengthBytes] = readLEB128(src, pos);
    const start = pos + lengthBytes;
    return [new TextDecoder().decode(src.subarray(start, start + length)), start + length];
  }

  function skipLimits(pos: number): number {
    const [flags, flagsBytes] = readLEB128(src, pos);
    pos += flagsBytes;
    const [, minBytes] = readLEB128(src, pos);
    pos += minBytes;
    if (flags & 1) {
      const [, maxBytes] = readLEB128(src, pos);
      pos += maxBytes;
    }
    return pos;
  }

  function skipValueType(pos: number): number {
    const type = src[pos++];
    // Typed references encode a heap type after ref.null/ref.
    if (type === 0x63 || type === 0x64) {
      const [, heapTypeBytes] = readLEB128(src, pos);
      pos += heapTypeBytes;
    }
    return pos;
  }

  interface Section { id: number; offset: number; totalSize: number; contentOffset: number; contentSize: number; }
  const sections: Section[] = [];
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const totalSize = 1 + sizeBytes + sectionSize;
    sections.push({ id: sectionId, offset, totalSize, contentOffset, contentSize: sectionSize });
    offset += totalSize;
  }

  const functionTypeIndices: number[] = [];
  let numFuncImports = 0;
  const exportFuncIndicesByName = new Map<string, number>();
  let typeSection: Section | null = null;
  let codeSection: Section | null = null;

  for (const sec of sections) {
    if (sec.id === 1) {
      typeSection = sec;
    } else if (sec.id === 2) {
      let pos = sec.contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        [, pos] = readName(pos);
        [, pos] = readName(pos);
        const kind = src[pos++];
        if (kind === 0) {
          const [typeIndex, typeIndexBytes] = readLEB128(src, pos);
          pos += typeIndexBytes;
          functionTypeIndices.push(typeIndex);
          numFuncImports++;
        } else if (kind === 1) {
          pos = skipValueType(pos);
          pos = skipLimits(pos);
        } else if (kind === 2) {
          pos = skipLimits(pos);
        } else if (kind === 3) {
          pos = skipValueType(pos) + 1;
        } else if (kind === 4) {
          pos++; // tag attribute
          const [, typeIndexBytes] = readLEB128(src, pos);
          pos += typeIndexBytes;
        }
      }
    } else if (sec.id === 3) {
      let pos = sec.contentOffset;
      const [functionCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < functionCount; i++) {
        const [typeIndex, typeIndexBytes] = readLEB128(src, pos);
        pos += typeIndexBytes;
        functionTypeIndices.push(typeIndex);
      }
    } else if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        let name: string;
        [name, pos] = readName(pos);
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0) exportFuncIndicesByName.set(name, idx);
      }
    } else if (sec.id === 10) {
      codeSection = sec;
    }
  }

  function getInstructionBounds(funcIndex: number): { start: number; end: number } | null {
    if (!codeSection) return null;
    const codeEntry = funcIndex - numFuncImports;
    if (codeEntry < 0) return null;

    let pos = codeSection.contentOffset;
    const [funcCount, funcCountBytes] = readLEB128(src, pos);
    pos += funcCountBytes;
    if (codeEntry >= funcCount) return null;

    for (let i = 0; i < codeEntry; i++) {
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }

    const [bodySize, bodySizeBytes] = readLEB128(src, pos);
    pos += bodySizeBytes;
    const bodyEnd = pos + bodySize;

    const [localCount, localCountBytes] = readLEB128(src, pos);
    pos += localCountBytes;
    for (let i = 0; i < localCount; i++) {
      const [, localRunLengthBytes] = readLEB128(src, pos);
      pos += localRunLengthBytes;
      pos = skipValueType(pos);
    }

    return { start: pos, end: bodyEnd };
  }

  const ctorCandidates = new Map<number, string[]>();
  const addCtorCandidate = (index: number | undefined, source: string) => {
    if (index === undefined) return;
    const sources = ctorCandidates.get(index) ?? [];
    sources.push(source);
    ctorCandidates.set(index, sources);
  };

  addCtorCandidate(exportFuncIndicesByName.get("__wasm_call_ctors"), "function export");

  // Unstripped modules can retain the exact synthetic function name even when
  // it is not exported. Fork instrumentation appends to this same name map.
  for (const sec of sections) {
    if (sec.id !== 0) continue;
    let pos = sec.contentOffset;
    let customName: string;
    [customName, pos] = readName(pos);
    if (customName !== "name") continue;
    const sectionEnd = sec.contentOffset + sec.contentSize;
    while (pos < sectionEnd) {
      const subsectionId = src[pos++];
      const [subsectionSize, sizeBytes] = readLEB128(src, pos);
      pos += sizeBytes;
      const subsectionEnd = pos + subsectionSize;
      if (subsectionId === 1) {
        const [nameCount, countBytes] = readLEB128(src, pos);
        pos += countBytes;
        for (let i = 0; i < nameCount; i++) {
          const [funcIndex, indexBytes] = readLEB128(src, pos);
          pos += indexBytes;
          let functionName: string;
          [functionName, pos] = readName(pos);
          if (functionName === "__wasm_call_ctors") {
            addCtorCandidate(funcIndex, "name section");
          }
        }
      }
      pos = subsectionEnd;
    }
  }

  const abiMarkerIndex = exportFuncIndicesByName.get("__abi_version");
  if (abiMarkerIndex !== undefined && extractAbiVersion(bytes) !== null) {
    const bounds = getInstructionBounds(abiMarkerIndex);
    if (bounds && src[bounds.start] === 0x10) {
      const [target] = readLEB128(src, bounds.start + 1);
      addCtorCandidate(target, "__abi_version linker wrapper");
    }
  }

  if (ctorCandidates.size > 1) {
    const evidence = [...ctorCandidates]
      .map(([index, sources]) => `${index} (${sources.join(", ")})`)
      .join("; ");
    throw new Error(`Conflicting __wasm_call_ctors evidence: ${evidence}`);
  }

  const ctorFuncIndex = ctorCandidates.keys().next().value as number | undefined;
  const hasStartSection = sections.some((sec) => sec.id === 8);
  if (ctorFuncIndex === undefined && !hasStartSection) return bytes;

  let ctorCodeEntry = -1;
  if (ctorFuncIndex !== undefined) {
    ctorCodeEntry = ctorFuncIndex - numFuncImports;
    const typeIndex = functionTypeIndices[ctorFuncIndex];
    if (ctorCodeEntry < 0 || !codeSection || typeIndex === undefined || !typeSection) {
      throw new Error(`__wasm_call_ctors function ${ctorFuncIndex} has no defined function body`);
    }

    let pos = typeSection.contentOffset;
    const [typeCount, countBytes] = readLEB128(src, pos);
    pos += countBytes;
    let signature: { params: number; results: number } | null = null;
    for (let i = 0; i < typeCount; i++) {
      const form = src[pos++];
      if (form !== 0x60) break;
      const [paramCount, paramCountBytes] = readLEB128(src, pos);
      pos += paramCountBytes;
      for (let param = 0; param < paramCount; param++) pos = skipValueType(pos);
      const [resultCount, resultCountBytes] = readLEB128(src, pos);
      pos += resultCountBytes;
      for (let result = 0; result < resultCount; result++) pos = skipValueType(pos);
      if (i === typeIndex) signature = { params: paramCount, results: resultCount };
    }

    const evidence = ctorCandidates.get(ctorFuncIndex) ?? [];
    const markerProvesVoidSignature = evidence.includes("__abi_version linker wrapper");
    if (!signature && !markerProvesVoidSignature) {
      throw new Error(
        `Cannot inspect __wasm_call_ctors function ${ctorFuncIndex} signature from this type section`,
      );
    }
    if (signature && (signature.params !== 0 || signature.results !== 0)) {
      throw new Error(
        `__wasm_call_ctors function ${ctorFuncIndex} must have type () -> (), ` +
          `found ${signature.params} parameter(s) and ${signature.results} result(s)`,
      );
    }
  }

  // Build output: always skip Start section; optionally neuter constructor function
  const chunks: Uint8Array[] = [];
  chunks.push(src.subarray(0, 8)); // Wasm header

  for (const sec of sections) {
    if (sec.id === 8) {
      continue; // Skip start section
    }

    if (sec.id === 10 && ctorCodeEntry >= 0) {
      // Code section: replace constructor function body with no-op
      let pos = sec.contentOffset;
      const [funcCount, funcCountBytes] = readLEB128(src, pos);
      pos += funcCountBytes;

      // Locate the constructor function body
      let targetBodyStart = pos;
      for (let i = 0; i < ctorCodeEntry; i++) {
        const [bodySize, bodySizeBytes] = readLEB128(src, targetBodyStart);
        targetBodyStart += bodySizeBytes + bodySize;
      }
      const [origBodySize, origBodySizeBytes] = readLEB128(src, targetBodyStart);
      const origBodyEnd = targetBodyStart + origBodySizeBytes + origBodySize;

      // New body: size=2, content = 0x00 (0 locals) + 0x0B (end)
      const newBody = new Uint8Array([2, 0, 0x0b]);

      // Compute new section content size
      const beforeTarget = targetBodyStart - sec.contentOffset;
      const afterTarget = (sec.contentOffset + sec.contentSize) - origBodyEnd;
      const newContentSize = beforeTarget + newBody.length + afterTarget;
      const newSectionSizeBytes = encodeLEB128(newContentSize);

      chunks.push(new Uint8Array([10])); // section id
      chunks.push(new Uint8Array(newSectionSizeBytes));
      chunks.push(src.subarray(sec.contentOffset, targetBodyStart)); // func count + bodies before target
      chunks.push(newBody); // patched function body
      chunks.push(src.subarray(origBodyEnd, sec.contentOffset + sec.contentSize)); // bodies after target
    } else {
      // Copy section as-is
      chunks.push(src.subarray(sec.offset, sec.offset + sec.totalSize));
    }
  }

  // Concatenate chunks
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out.buffer;
}

/**
 * Thread worker entry point.
 *
 * Threads share the parent process's Memory. This function:
 * 1. Instantiates the same Wasm module with shared memory (start section stripped)
 * 2. Allocates TLS for the thread
 * 3. Sets the channel base and stack pointer
 * 4. Calls the thread function via the indirect function table
 * 5. On return: performs CLONE_CHILD_CLEARTID (write 0 + futex wake at ctidPtr)
 *
 * If the thread function calls fork(), this entry point drives the
 * `wpk_fork_*` unwind/SYS_FORK/rewind loop just like the main process worker,
 * but rooted at the pthread function and this thread's channel-local fork
 * buffer.
 */
export async function centralizedThreadWorkerMain(
  port: MessagePort,
  initData: CentralizedThreadInitMessage,
): Promise<void> {
  const { memory, channelOffset, pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr } = initData;
  const tlsOffset = initData.tlsOffset ?? initData.tlsAllocAddr;
  const ptrWidth = initData.ptrWidth ?? 4;

  let threadInstance: WebAssembly.Instance | undefined;

  try {
    // Strip the start section AND neuter the constructor function body to prevent
    // constructors from re-running. Thread instances share memory with the main
    // thread; re-running constructors would clobber global state.
    let programBytes: ArrayBuffer | null = null;
    if (!initData.programModule) {
      programBytes = patchWasmForThread(initData.programBytes);
    }
    const module = initData.programModule
      ? initData.programModule
      : new WebAssembly.Module(programBytes!);

    const moduleExports = WebAssembly.Module.exports(module);
    const hasForkInstrumentation = hasCompleteForkInstrumentation(moduleExports, pid);
    const forkBufAddr = channelOffset - FORK_BUF_SIZE;
    let forkResult = 0;

    let kernelThreadExitStatus: number | null = null;
    const kernelImports = buildKernelImports(
      memory,
      channelOffset,
      undefined,
      undefined,
      (status) => {
        kernelThreadExitStatus = status;
      },
    );
    if (hasForkInstrumentation) {
      kernelImports.kernel_fork = (): number => {
        if (!threadInstance) return -38; // ENOSYS

        const getState = threadInstance.exports.wpk_fork_state as () => number;
        const state = getState();
        if (state === 2) {
          (threadInstance.exports.wpk_fork_rewind_end as () => void)();
          return forkResult;
        }

        (threadInstance.exports.wpk_fork_unwind_begin as (addr: number) => void)(forkBufAddr);
        return 0;
      };
    } else {
      kernelImports.kernel_fork = (): number => {
        throw new Error(
          `pid=${pid} tid=${tid}: kernel_fork reached without complete ` +
            "wasm-fork-instrument exports. Rebuild the program with " +
            "scripts/run-wasm-fork-instrument.sh.",
        );
      };
    }
    const importObject = buildImportObject(module, memory, kernelImports, channelOffset, undefined,
      () => threadInstance, ptrWidth);
    const instance = new WebAssembly.Instance(module, importObject);
    threadInstance = instance;

    // Initialize Wasm TLS for this thread in the slot's explicit TLS/control page.
    const wasmInitTls = instance.exports.__wasm_init_tls as ((addr: number | bigint) => void) | undefined;
    const tlsBlock = tlsOffset;

    if (wasmInitTls && tlsBlock > 0) {
      wasmInitTls(ptrWidth === 8 ? BigInt(tlsBlock) : tlsBlock);
    }

    // Set __stack_pointer
    const stackPointer = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
    if (stackPointer) {
      stackPointer.value = ptrWidth === 8 ? BigInt(stackPtr) : stackPtr;
    }

    // Initialize musl thread pointer if available
    const wasmThreadInit = instance.exports.__wasm_thread_init as ((tp: number | bigint) => void) | undefined;
    if (wasmThreadInit && tlsPtr > 0) {
      wasmThreadInit(ptrWidth === 8 ? BigInt(tlsPtr) : tlsPtr);
    }

    // Set __channel_base without calling the exported helper. lld can prefix
    // exported functions with __wasm_call_ctors, and thread workers must not
    // re-run constructors in shared process memory.
    setupChannelBase(instance, module, memory, channelOffset, initData.programBytes, ptrWidth);

    // Call the thread function via indirect function table
    const table = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
    if (!table) {
      throw new Error("No __indirect_function_table export — cannot call thread function");
    }

    // On wasm64, table indices may require BigInt (table64 extension)
    const tableIdx = ptrWidth === 8 ? BigInt(fnPtr) : fnPtr;
    const threadFn = table.get(tableIdx as number) as ((...args: (number | bigint)[]) => number | bigint) | null;
    if (!threadFn) {
      throw new Error(`Thread function at table index ${fnPtr} is null`);
    }

    const startPromise = new Promise<void>((resolve) => {
      let started = false;
      port.on("message", (raw: unknown) => {
        const message = raw as { type?: string; pid?: number; tid?: number };
        if (
          !started &&
          message.type === "thread_start" &&
          message.pid === pid &&
          message.tid === tid
        ) {
          started = true;
          resolve();
        }
      });
    });

    // clone() must not report success until the Worker has instantiated the
    // patched module, initialized TLS/stack/channel state, and resolved the
    // requested table entry. It waits here until the kernel has published the
    // successful clone result to the caller's channel.
    port.postMessage({
      type: "thread_ready",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
    await startPromise;

    const threadArg = ptrWidth === 8 ? BigInt(argPtr) : argPtr;
    let result = 0;
    if (hasForkInstrumentation) {
      const getState = instance.exports.wpk_fork_state as () => number;
      const unwindEnd = instance.exports.wpk_fork_unwind_end as () => void;
      const rewindBegin = instance.exports.wpk_fork_rewind_begin as (addr: number) => void;
      let needsRewind = false;

      for (;;) {
        if (needsRewind) {
          rewindBegin(forkBufAddr);
          needsRewind = false;
        }

        try {
          const raw = threadFn(threadArg);
          result = Number(raw);
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.includes("unreachable") &&
            kernelThreadExitStatus !== null
          ) {
            result = kernelThreadExitStatus;
            break;
          }
          throw e;
        }

        const forkState = getState();
        if (forkState === 1) {
          unwindEnd();
          const childPid = sendForkSyscall(memory, channelOffset);
          if (childPid < 0) {
            throw new Error(`Fork failed: errno=${-childPid}`);
          }
          forkResult = childPid;
          needsRewind = true;
          continue;
        }
        break;
      }
    } else {
      try {
        const raw = threadFn(threadArg);
        result = Number(raw);
      } catch (e) {
        if (
          e instanceof Error &&
          e.message.includes("unreachable") &&
          kernelThreadExitStatus !== null
        ) {
          result = kernelThreadExitStatus;
        } else {
          throw e;
        }
      }
    }

    // Send SYS_EXIT through the channel. The kernel worker performs
    // CLONE_CHILD_CLEARTID after it observes SYS_EXIT; doing it here would
    // let pthread_join reclaim the stack while this Worker is still running.
    {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + CH_SYSCALL, ABI_SYSCALLS.Exit, true);
      view.setInt32(base + CH_ARGS, result ?? 0, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(i32, (base + CH_STATUS) / 4, 1);
      // Wait for kernel to process the exit. The kernel completes the channel
      // (CH_STATUS -> COMPLETE), which returns this Atomics.wait.
      while (Atomics.wait(i32, (base + CH_STATUS) / 4, CHANNEL_STATUS_PENDING) === "ok") { /* */ }
      // Intentionally do NOT reset CH_STATUS back to IDLE here. A normal syscall
      // resets to IDLE so the next syscall can set PENDING, but an exiting thread
      // issues no further syscalls — the channel is torn down and the slot is
      // re-zeroed when it is reclaimed for a future clone(). Writing here would be
      // the thread's only post-exit touch of the channel, so omitting it removes
      // any possibility of a late write landing on a reused slot's status word.
    }

    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    const message = err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : String(err);
    port.postMessage({
      type: "error",
      pid,
      message: `Thread worker failed: ${message}`,
    } satisfies WorkerToHostMessage);
  }
}
