/**
 * Centralized worker entry points.
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
import { DynamicLinker } from "./dylink";
import { WasiShim, WasiExit, isWasiModule, wasiModuleDefinesMemory } from "./wasi-shim";
export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Build kernel.* import stubs for channel-mode Wasm modules.
 * Both process and thread workers need these because the musl overlay CRT
 * imports kernel.* functions for argc/argv, environ, fork state, and clone.
 *
 * On wasm64, pointer params arrive as BigInt (i64). The helper `n()` converts
 * BigInt|number → number for memory access (all addresses < 4GB).
 */
function buildKernelImports(
  memory: WebAssembly.Memory,
  channelOffset: number,
  argv?: string[],
  envVars?: string[],
): Record<string, WebAssembly.ExportValue> {
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

    // Fork/exec state — not a fork child in centralized mode
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
      view.setInt32(base + 4, 34, true); // SYS_EXIT = 34
      view.setBigInt64(base + 8, BigInt(status), true); // arg0 as i64
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      // Wait for complete, then trap
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }
      Atomics.store(i32, base / 4, 0);
    },

    // Clone dispatches through channel (SYS_CLONE)
    kernel_clone: (fnPtr: number | bigint, stackPtr: number | bigint, flags: number,
      arg: number | bigint, ptidPtr: number | bigint, tlsPtr: number | bigint, ctidPtr: number | bigint): number => {
      const SYS_CLONE_NR = 201;
      const CH_ARG_SIZE = 8;
      const CH_RETURN = 56;
      const CH_ERRNO = 64;
      const CH_DATA = 72;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, SYS_CLONE_NR, true);
      view.setBigInt64(base + 8 + 0 * CH_ARG_SIZE, BigInt(flags), true);
      view.setBigInt64(base + 8 + 1 * CH_ARG_SIZE, BigInt(stackPtr), true);
      view.setBigInt64(base + 8 + 2 * CH_ARG_SIZE, BigInt(ptidPtr), true);
      view.setBigInt64(base + 8 + 3 * CH_ARG_SIZE, BigInt(tlsPtr), true);
      view.setBigInt64(base + 8 + 4 * CH_ARG_SIZE, BigInt(ctidPtr), true);
      view.setBigInt64(base + 8 + 5 * CH_ARG_SIZE, 0n, true);
      // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
      view.setUint32(base + CH_DATA, n(fnPtr), true);
      view.setUint32(base + CH_DATA + 4, n(arg), true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      Atomics.store(i32, base / 4, 0);

      if (err) return -err;
      return result;
    },

    // Fork dispatches through channel (SYS_FORK)
    kernel_fork: (): number => {
      const SYS_FORK_NR = 212;
      const CH_ARG_SIZE = 8;
      const CH_RETURN = 56;
      const CH_ERRNO = 64;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, SYS_FORK_NR, true);
      for (let i = 0; i < 6; i++) view.setBigInt64(base + 8 + i * CH_ARG_SIZE, 0n, true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

      const result = Number(view.getBigInt64(base + CH_RETURN, true));
      const err = view.getUint32(base + CH_ERRNO, true);
      Atomics.store(i32, base / 4, 0);

      if (err) return -err;
      return result;
    },
  };
}

/**
 * Build dlopen host imports for a process. These are called directly from
 * the user program's dlopen/dlsym/dlclose C stubs (glue/dlopen.c).
 *
 * The DynamicLinker is lazily created on first use since most programs
 * don't use dlopen.
 */
function buildDlopenImports(
  memory: WebAssembly.Memory,
  getTable: () => WebAssembly.Table | undefined,
  getStackPointer: () => WebAssembly.Global | undefined,
  getInstance: () => WebAssembly.Instance | undefined,
): Record<string, WebAssembly.ExportValue> {
  let linker: DynamicLinker | null = null;
  const decoder = new TextDecoder();

  // Shared library memory starts at 128MB to avoid conflicting with
  // the program's malloc heap (which starts at __heap_base, ~1MB).
  const DYLIB_MEMORY_BASE = 128 * 1024 * 1024;

  const getLinker = (): DynamicLinker => {
    if (linker) return linker;
    const table = getTable();
    const sp = getStackPointer();
    if (!table || !sp) throw new Error("dlopen: program has no table or stack pointer");

    // Register main program's exported functions as global symbols
    // so shared libraries can resolve references to libc, etc.
    const globalSymbols = new Map<string, Function | WebAssembly.Global>();
    const inst = getInstance();
    if (inst) {
      for (const [name, exp] of Object.entries(inst.exports)) {
        if (typeof exp === "function" && !name.startsWith("__")) {
          globalSymbols.set(name, exp);
        }
      }
    }

    linker = new DynamicLinker({
      memory,
      table,
      stackPointer: sp,
      heapPointer: { value: DYLIB_MEMORY_BASE },
      globalSymbols,
      got: new Map(),
      loadedLibraries: new Map(),
    });
    return linker;
  };

  return {
    __wasm_dlopen: (bytesPtr: number, bytesLen: number,
                    namePtr: number, nameLen: number): number => {
      const bytes = new Uint8Array(memory.buffer, bytesPtr, bytesLen);
      // Copy bytes since memory.buffer may detach during Wasm instantiation
      const bytesCopy = new Uint8Array(bytes);
      const nameBytes = new Uint8Array(memory.buffer, namePtr, nameLen);
      const name = decoder.decode(nameBytes);
      return getLinker().dlopenSync(name, bytesCopy);
    },

    __wasm_dlsym: (handle: number, namePtr: number, nameLen: number): number => {
      const nameBytes = new Uint8Array(memory.buffer, namePtr, nameLen);
      const name = decoder.decode(nameBytes);
      const result = getLinker().dlsym(handle, name);
      return result === null ? 0 : (result as number);
    },

    __wasm_dlclose: (handle: number): number => {
      return getLinker().dlclose(handle);
    },

    __wasm_dlerror: (bufPtr: number, bufMax: number): number => {
      const err = getLinker().dlerror();
      if (!err) return 0;
      const encoder = new TextEncoder();
      const encoded = encoder.encode(err);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
      return len;
    },
  };
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

/** Size of the asyncify data buffer used for fork stack save/restore */
const ASYNCIFY_BUF_SIZE = 16384;

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
    // Use pre-compiled module if provided (avoids recompilation in web workers)
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
        } else if (e instanceof Error && e.message.includes("unreachable")) {
          exitCode = 0;
        } else {
          throw e;
        }
      }

      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
      return;
    }

    // --- SDK module path (existing) ---
    const kernelImports = buildKernelImports(
      memory, channelOffset, initData.argv || [], initData.env || [],
    );

    // Check if the module has asyncify exports (compiled with wasm-opt --asyncify)
    const moduleExports = WebAssembly.Module.exports(module);
    const hasAsyncify = moduleExports.some(e => e.name === "asyncify_get_state");
    // Asyncify fork state — captured by kernel_fork closure
    let forkResult = 0;
    const asyncifyBufAddr = channelOffset - ASYNCIFY_BUF_SIZE;

    if (hasAsyncify) {
      // Override kernel_fork with asyncify-aware version.
      // Late-bound: processInstance is set after instantiation.
      let processInstance: WebAssembly.Instance | null = null;

      kernelImports.kernel_fork = (): number => {
        if (!processInstance) return -38; // ENOSYS

        const getState = processInstance.exports.asyncify_get_state as () => number;
        const state = getState();
        if (state === 2) {
          // Rewinding: stop rewind and return the stored fork result
          (processInstance.exports.asyncify_stop_rewind as () => void)();
          return forkResult;
        }

        // Normal call: start asyncify unwind to save the call stack.
        // SYS_FORK is sent after _start returns (unwind complete).
        const view = new DataView(memory.buffer);
        view.setInt32(asyncifyBufAddr, asyncifyBufAddr + 8, true);     // start ptr
        view.setInt32(asyncifyBufAddr + 4, asyncifyBufAddr + ASYNCIFY_BUF_SIZE, true); // end ptr
        (processInstance.exports.asyncify_start_unwind as (addr: number) => void)(asyncifyBufAddr);
        return 0; // ignored during unwind
      };

      // Build import object and instantiate
      const dlopenImports = buildDlopenImports(
        memory,
        () => processInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined,
        () => processInstance?.exports.__stack_pointer as WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
      );
      const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenImports,
        () => processInstance ?? undefined, ptrWidth);
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;

      // For fork children: fix __tls_base and __stack_pointer after instantiation.
      // Both globals are reset to defaults by WebAssembly.instantiate() but need
      // the parent's values for correct operation.
      if (initData.isForkChild && initData.asyncifyBufAddr != null) {
        const view = new DataView(memory.buffer);

        // Restore __tls_base: child's __wasm_init_memory skips __wasm_init_tls
        // because the init flag is already set (copied from parent memory),
        // leaving __tls_base at 0 instead of the correct TLS segment address.
        const tlsBaseGlobal = instance.exports.__tls_base as WebAssembly.Global | undefined;
        if (tlsBaseGlobal) {
          if (ptrWidth === 8) {
            const savedBase = Number(view.getBigUint64(initData.asyncifyBufAddr - 8, true));
            if (savedBase > 0) tlsBaseGlobal.value = BigInt(savedBase);
          } else {
            const savedBase = view.getUint32(initData.asyncifyBufAddr - 4, true);
            if (savedBase > 0) tlsBaseGlobal.value = savedBase;
          }
        }

        // Restore __stack_pointer: the child's fresh wasm instance has the
        // module default __stack_pointer (top of shadow stack). But the parent's
        // was lower (stack grows down). Asyncify rewind restores wasm locals but
        // NOT globals. Without this, function calls in the child allocate shadow
        // stack frames from the wrong base, overlapping the parent function's
        // locals (corrupting arrays, structs on the shadow stack).
        const stackPtrGlobal = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
        if (stackPtrGlobal) {
          if (ptrWidth === 8) {
            const savedSp = Number(view.getBigUint64(initData.asyncifyBufAddr - 16, true));
            if (savedSp > 0) stackPtrGlobal.value = BigInt(savedSp);
          } else {
            const savedSp = view.getUint32(initData.asyncifyBufAddr - 8, true);
            if (savedSp > 0) stackPtrGlobal.value = savedSp;
          }
        }
      }

      // Set __channel_base in TLS
      setupChannelBase(instance, module, memory, channelOffset, programBytes as ArrayBuffer, ptrWidth);

      // Signal ready
      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      // Run with asyncify fork support
      let exitCode = 0;
      try {
        const start = instance.exports._start as () => void;
        const getState = instance.exports.asyncify_get_state as () => number;
        const stopUnwind = instance.exports.asyncify_stop_unwind as () => void;
        const startRewind = instance.exports.asyncify_start_rewind as (addr: number) => void;

        // For fork children: start with rewind to resume from fork point
        let needsRewind = !!initData.isForkChild;
        if (needsRewind) {
          forkResult = 0; // fork() returns 0 in child
        }

        // Use parent's asyncify buffer address for child rewind
        const rewindAddr = initData.isForkChild && initData.asyncifyBufAddr != null
          ? initData.asyncifyBufAddr
          : asyncifyBufAddr;

        for (;;) {
          if (needsRewind) {
            startRewind(rewindAddr);
            needsRewind = false;
          }

          try {
            start();
          } catch (e) {
            if (e instanceof Error && e.message.includes("unreachable")) {
              break; // Normal exit via kernel_exit → unreachable trap
            }
            throw e;
          }

          const asyncState = getState();
          if (asyncState === 1) {
            // Asyncify unwind completed (fork) — finalize and send SYS_FORK
            stopUnwind();

            // Save TLS data for the fork child before the host copies memory.
            // The child's WebAssembly.instantiate() will run __wasm_init_memory
            // which calls __wasm_init_tls, overwriting the TLS area with template
            // values and resetting __wasm_thread_pointer to 0.
            saveParentTls(instance, memory, asyncifyBufAddr, ptrWidth);

            // Send SYS_FORK through the channel now that memory has asyncify data
            const childPid = sendForkSyscall(memory, channelOffset);
            if (childPid < 0) {
              throw new Error(`Fork failed: errno=${-childPid}`);
            }
            forkResult = childPid;
            needsRewind = true;
            continue;
          }

          // Normal return — program finished
          break;
        }
      } catch (e) {
        if (!(e instanceof Error && e.message.includes("unreachable"))) {
          throw e;
        }
      }

      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
    } else {
      // No asyncify — use original channel-based fork (re-execute _start)
      // Fork children re-execute _start: first kernel_fork call returns 0
      if (initData.isForkChild) {
        let firstFork = true;
        const origKernelFork = kernelImports.kernel_fork;
        kernelImports.kernel_fork = (): number => {
          if (firstFork) {
            firstFork = false;
            return 0; // fork() returns 0 in child
          }
          return (origKernelFork as () => number)();
        };
      }

      let processInstance: WebAssembly.Instance | null = null;
      const dlopenImports = buildDlopenImports(
        memory,
        () => processInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined,
        () => processInstance?.exports.__stack_pointer as WebAssembly.Global | undefined,
        () => processInstance ?? undefined,
      );
      const importObject = buildImportObject(module, memory, kernelImports, channelOffset, dlopenImports,
        () => processInstance ?? undefined, ptrWidth);
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;

      setupChannelBase(instance, module, memory, channelOffset, programBytes as ArrayBuffer, ptrWidth);

      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
      } catch (e) {
        if (e instanceof Error && e.message.includes("unreachable")) {
          console.error(`[worker] pid=${pid} _start() hit unreachable trap: ${e.message}`);
          exitCode = 0;
        } else {
          throw e;
        }
      }

      console.error(`[worker] pid=${pid} _start() returned, exitCode=${exitCode}`);
      port.postMessage({ type: "exit", pid, status: exitCode } satisfies WorkerToHostMessage);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Centralized worker failed: ${errMsg}`,
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

    // Pattern 3: post-asyncify — global.get <tls_base>; i32/i64.const <offset>; i32/i64.add
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
 * Save parent's __tls_base and __stack_pointer before fork so the child can
 * restore them.
 *
 * __tls_base: The child's WebAssembly.instantiate() skips __wasm_init_tls
 * (init flag is set from copied parent memory), leaving __tls_base at 0.
 * Stored at [asyncifyBufAddr - 4].
 *
 * __stack_pointer: The child gets a fresh wasm instance whose __stack_pointer
 * is the module default (top of shadow stack). But the parent's __stack_pointer
 * was lower (stack grows down). After asyncify rewind, wasm locals are restored
 * but __stack_pointer (a global) is NOT. Any function call in the child would
 * allocate its shadow stack frame from the wrong base, overlapping and corrupting
 * the parent function's shadow stack locals (arrays, structs).
 * Stored at [asyncifyBufAddr - 8].
 */
function saveParentTls(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
  asyncifyBufAddr: number,
  ptrWidth: 4 | 8 = 4,
): void {
  const view = new DataView(memory.buffer);

  const tlsBaseGlobal = instance.exports.__tls_base as WebAssembly.Global | undefined;
  if (tlsBaseGlobal) {
    const tlsBase = Number(tlsBaseGlobal.value);
    if (tlsBase > 0) {
      if (ptrWidth === 8) {
        view.setBigUint64(asyncifyBufAddr - 8, BigInt(tlsBase), true);
      } else {
        view.setUint32(asyncifyBufAddr - 4, tlsBase, true);
      }
    }
  }

  const stackPtrGlobal = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
  if (stackPtrGlobal) {
    const stackPtr = Number(stackPtrGlobal.value);
    if (stackPtr > 0) {
      if (ptrWidth === 8) {
        view.setBigUint64(asyncifyBufAddr - 16, BigInt(stackPtr), true);
      } else {
        view.setUint32(asyncifyBufAddr - 8, stackPtr, true);
      }
    }
  }
}

/**
 * Send SYS_FORK through the channel and wait for the result.
 * Returns child pid on success, or -errno on failure.
 */
function sendForkSyscall(memory: WebAssembly.Memory, channelOffset: number): number {
  const SYS_FORK_NR = 212;
  const CH_SYSCALL = 4;
  const CH_ARGS = 8;
  const CH_ARG_SIZE = 8; // each arg is i64 (8 bytes)
  const CH_RETURN = 56;
  const CH_ERRNO = 64;

  const view = new DataView(memory.buffer);
  view.setInt32(channelOffset + CH_SYSCALL, SYS_FORK_NR, true);
  for (let i = 0; i < 6; i++) {
    view.setBigInt64(channelOffset + CH_ARGS + i * CH_ARG_SIZE, 0n, true);
  }

  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, channelOffset / 4, 1); // CH_PENDING
  Atomics.notify(i32, channelOffset / 4, 1);
  while (Atomics.wait(i32, channelOffset / 4, 1) === "ok") { /* */ }

  const result = Number(view.getBigInt64(channelOffset + CH_RETURN, true));
  const err = view.getUint32(channelOffset + CH_ERRNO, true);
  Atomics.store(i32, channelOffset / 4, 0);

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
 * 2. Finds the constructor function (by inspecting the first `call` instruction
 *    in any export wrapper) and replaces its body with a no-op.
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

  // Parse all sections
  interface Section { id: number; offset: number; totalSize: number; contentOffset: number; contentSize: number; }
  const sections: Section[] = [];
  let numFuncImports = 0;
  let hasStartSection = false;
  let offset = 8;

  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readLEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const totalSize = 1 + sizeBytes + sectionSize;
    sections.push({ id: sectionId, offset, totalSize, contentOffset, contentSize: sectionSize });
    if (sectionId === 8) hasStartSection = true;
    offset += totalSize;
  }

  if (!hasStartSection) return bytes;

  // Count function imports from Import section (id=2)
  for (const sec of sections) {
    if (sec.id === 2) {
      let pos = sec.contentOffset;
      const [importCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readLEB128(src, pos);
        pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readLEB128(src, pos);
        pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 0) { // function import
          numFuncImports++;
          const [, typeIdxBytes] = readLEB128(src, pos);
          pos += typeIdxBytes;
        } else if (kind === 1) { // table
          pos++; // reftype
          const flags = src[pos++];
          const [, minBytes] = readLEB128(src, pos); pos += minBytes;
          if (flags & 1) { const [, maxBytes] = readLEB128(src, pos); pos += maxBytes; }
        } else if (kind === 2) { // memory
          const flags = src[pos++];
          const [, minBytes] = readLEB128(src, pos); pos += minBytes;
          if (flags & 1) { const [, maxBytes] = readLEB128(src, pos); pos += maxBytes; }
        } else if (kind === 3) { // global
          pos++; // valtype
          pos++; // mutability
        }
      }
      break;
    }
  }

  // Find the constructor function by looking at an export wrapper's first `call`.
  // In LLVM's shared-memory model, every export wrapper starts with `call $__wasm_call_ctors`.
  // We find this by locating any exported function's code and reading its first call target.
  let ctorFuncIndex = -1;
  let exportedFuncIndices: number[] = [];

  // Collect exported function indices from Export section (id=7)
  for (const sec of sections) {
    if (sec.id === 7) {
      let pos = sec.contentOffset;
      const [exportCount, countBytes] = readLEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readLEB128(src, pos);
        pos += nameLenBytes + nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readLEB128(src, pos);
        pos += idxBytes;
        if (kind === 0) { // function export
          exportedFuncIndices.push(idx);
        }
      }
      break;
    }
  }

  // Find the Code section and look at an exported function's body
  for (const sec of sections) {
    if (sec.id === 10 && exportedFuncIndices.length > 0) {
      // Use the last exported function (likely a wrapper, not a data export)
      const targetFunc = exportedFuncIndices[exportedFuncIndices.length - 1];
      const targetCodeEntry = targetFunc - numFuncImports;
      if (targetCodeEntry < 0) break;

      let pos = sec.contentOffset;
      const [, funcCountBytes] = readLEB128(src, pos);
      pos += funcCountBytes;

      // Skip to the target code entry
      for (let i = 0; i < targetCodeEntry; i++) {
        const [bodySize, bodySizeBytes] = readLEB128(src, pos);
        pos += bodySizeBytes + bodySize;
      }

      // Read the function body
      const [bodySize, bodySizeBytes] = readLEB128(src, pos);
      pos += bodySizeBytes;
      // Skip locals
      const [localCount, localCountBytes] = readLEB128(src, pos);
      pos += localCountBytes;
      for (let i = 0; i < localCount; i++) {
        const [, countB] = readLEB128(src, pos); pos += countB;
        pos++; // valtype
      }
      // First instruction should be `call N` (opcode 0x10 followed by LEB128 func index)
      if (src[pos] === 0x10) {
        [ctorFuncIndex] = readLEB128(src, pos + 1);
      }
      break;
    }
  }

  const ctorCodeEntry = ctorFuncIndex >= 0 ? ctorFuncIndex - numFuncImports : -1;
  if (ctorFuncIndex < 0) {
    // No ctor found — still strip start section but can't neuter the ctor body
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
 * Thread worker entry point for centralized mode.
 *
 * Threads share the parent process's Memory. This function:
 * 1. Instantiates the same Wasm module with shared memory (start section stripped)
 * 2. Allocates TLS for the thread
 * 3. Sets the channel base and stack pointer
 * 4. Calls the thread function via the indirect function table
 * 5. On return: performs CLONE_CHILD_CLEARTID (write 0 + futex wake at ctidPtr)
 */
export async function centralizedThreadWorkerMain(
  port: MessagePort,
  initData: CentralizedThreadInitMessage,
): Promise<void> {
  const { memory, channelOffset, pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, tlsAllocAddr } = initData;
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

    const kernelImports = buildKernelImports(memory, channelOffset);
    const importObject = buildImportObject(module, memory, kernelImports, channelOffset, undefined,
      () => threadInstance, ptrWidth);
    const instance = new WebAssembly.Instance(module, importObject);
    threadInstance = instance;

    // Initialize Wasm TLS for this thread.
    // IMPORTANT: We place TLS data inside the channel's spill page (after the
    // 72-byte channel header spill) rather than on the separate TLS page.
    // This avoids a corruption issue where unidentified wasm code writes to
    // page-aligned addresses in the thread region, overwriting __channel_base.
    // The channel spill page has 65464 bytes free after the header; we only need 8.
    const wasmInitTls = instance.exports.__wasm_init_tls as ((addr: number | bigint) => void) | undefined;
    const CH_TOTAL = 65608; // CH_HEADER_SIZE (72) + CH_DATA_SIZE (65536)
    const safeTlsAddr = channelOffset + CH_TOTAL; // inside channel spill page, 4-byte aligned
    const tlsBlock = safeTlsAddr;

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

    // Set __channel_base — either via wasm global (new) or TLS memory (legacy).
    const getChannelBaseAddr = instance.exports.__get_channel_base_addr as (() => number | bigint) | undefined;
    if (getChannelBaseAddr) {
      const addr = Number(getChannelBaseAddr());
      if (addr === 0) {
        // Global-based approach — __channel_base was set at instantiation via
        // WebAssembly.Global in buildImportObject. Nothing to do.
      } else {
        // Legacy TLS-based approach
        const view = new DataView(memory.buffer);
        if (ptrWidth === 8) {
          view.setBigUint64(addr, BigInt(channelOffset), true);
        } else {
          view.setUint32(addr, channelOffset, true);
        }
      }
    } else if (tlsBlock > 0) {
      // Fallback: assume offset 0 (only for programs without the helper)
      const view = new DataView(memory.buffer);
      if (ptrWidth === 8) {
        view.setBigUint64(tlsBlock, BigInt(channelOffset), true);
      } else {
        view.setUint32(tlsBlock, channelOffset, true);
      }
    }

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

    let result: number;
    try {
      const raw = threadFn(ptrWidth === 8 ? BigInt(argPtr) : argPtr);
      result = Number(raw);
    } catch (e) {
      if (e instanceof Error && e.message.includes("unreachable")) {
        // Thread exited via kernel_exit → unreachable trap
        result = 0;
      } else if (e instanceof Error && e.message.includes("null function or function signature mismatch")) {
        // call_indirect type mismatch — treat as thread crash but don't abort
        result = 0;
      } else {
        throw e;
      }
    }

    // CLONE_CHILD_CLEARTID: write 0 to ctidPtr and futex-wake it
    if (ctidPtr !== 0) {
      const view = new DataView(memory.buffer);
      view.setInt32(ctidPtr, 0, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.notify(i32, ctidPtr / 4, 1);
    }

    // Send SYS_EXIT through channel to notify kernel of thread exit
    {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, 34, true); // SYS_EXIT = 34
      view.setInt32(base + 8, result ?? 0, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      // Wait for kernel to process the exit
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }
      Atomics.store(i32, base / 4, 0);
    }

    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  }
}
