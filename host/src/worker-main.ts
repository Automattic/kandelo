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

export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Build kernel.* import stubs for channel-mode Wasm modules.
 * Both process and thread workers need these because the musl overlay CRT
 * imports kernel.* functions for argc/argv, environ, fork state, and clone.
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

  return {
    // CRT argv support
    kernel_get_argc: (): number => _argv.length,
    kernel_argv_read: (index: number, bufPtr: number, bufMax: number): number => {
      if (index >= _argv.length) return 0;
      const encoded = encoder.encode(_argv[index]);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
      return len;
    },

    // CRT environ support
    kernel_environ_count: (): number => _envVars.length,
    kernel_environ_get: (index: number, bufPtr: number, bufMax: number): number => {
      if (index >= _envVars.length) return -1;
      const encoded = encoder.encode(_envVars[index]);
      const len = Math.min(encoded.length, bufMax);
      new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
      return len;
    },

    // Fork/exec state — not a fork child in centralized mode
    kernel_is_fork_child: (): number => 0,
    kernel_apply_fork_fd_actions: (): number => 0,
    kernel_get_fork_exec_path: (_buf: number, _max: number): number => 0,
    kernel_get_fork_exec_argc: (): number => 0,
    kernel_get_fork_exec_argv: (_index: number, _buf: number, _max: number): number => 0,
    kernel_push_argv: (_ptr: number, _len: number): number => 0,
    kernel_clear_fork_exec: (): number => 0,

    // Exec dispatches through channel
    kernel_execve: (_pathPtr: number): number => -38, // ENOSYS

    // Exit dispatches through channel (SYS_EXIT)
    kernel_exit: (status: number): void => {
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, 34, true); // SYS_EXIT = 34
      view.setInt32(base + 8, status, true);
      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      // Wait for complete, then trap
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }
      Atomics.store(i32, base / 4, 0);
    },

    // Clone dispatches through channel (SYS_CLONE)
    kernel_clone: (fnPtr: number, stackPtr: number, flags: number,
      arg: number, ptidPtr: number, tlsPtr: number, ctidPtr: number): number => {
      const SYS_CLONE_NR = 201;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, SYS_CLONE_NR, true);
      view.setInt32(base + 8, flags, true);
      view.setInt32(base + 12, stackPtr, true);
      view.setInt32(base + 16, ptidPtr, true);
      view.setInt32(base + 20, tlsPtr, true);
      view.setInt32(base + 24, ctidPtr, true);
      view.setInt32(base + 28, 0, true);
      // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
      view.setUint32(base + 40, fnPtr, true);
      view.setUint32(base + 44, arg, true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

      const result = view.getInt32(base + 32, true);
      const err = view.getUint32(base + 36, true);
      Atomics.store(i32, base / 4, 0);

      if (err) return -err;
      return result;
    },

    // Fork dispatches through channel (SYS_FORK)
    kernel_fork: (): number => {
      const SYS_FORK_NR = 212;
      const view = new DataView(memory.buffer);
      const base = channelOffset;
      view.setInt32(base + 4, SYS_FORK_NR, true);
      for (let i = 0; i < 6; i++) view.setInt32(base + 8 + i * 4, 0, true);

      const i32 = new Int32Array(memory.buffer);
      Atomics.store(i32, base / 4, 1); // CH_PENDING
      Atomics.notify(i32, base / 4, 1);
      while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

      const result = view.getInt32(base + 32, true);
      const err = view.getUint32(base + 36, true);
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
  dlopenImports?: Record<string, WebAssembly.ExportValue>,
): WebAssembly.Imports {
  const envImports: Record<string, WebAssembly.ExportValue> = { memory };

  // Add dlopen imports if provided
  if (dlopenImports) {
    Object.assign(envImports, dlopenImports);
  }

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
    // Use pre-compiled module if provided (avoids recompilation in web workers)
    const module = initData.programModule
      ? initData.programModule
      : await WebAssembly.compile(programBytes);
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
      const importObject = buildImportObject(module, memory, kernelImports, dlopenImports);
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
          const savedBase = view.getUint32(initData.asyncifyBufAddr - 4, true);
          if (savedBase > 0) {
            tlsBaseGlobal.value = savedBase;
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
          const savedSp = view.getUint32(initData.asyncifyBufAddr - 8, true);
          if (savedSp > 0) {
            stackPtrGlobal.value = savedSp;
          }
        }
      }

      // Set __channel_base in TLS
      setupChannelBase(instance, memory, channelOffset, programBytes as ArrayBuffer);

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

          if (getState() === 1) {
            // Asyncify unwind completed (fork) — finalize and send SYS_FORK
            stopUnwind();

            // Save TLS data for the fork child before the host copies memory.
            // The child's WebAssembly.instantiate() will run __wasm_init_memory
            // which calls __wasm_init_tls, overwriting the TLS area with template
            // values and resetting __wasm_thread_pointer to 0.
            saveParentTls(instance, memory, asyncifyBufAddr);

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
      const importObject = buildImportObject(module, memory, kernelImports, dlopenImports);
      const instance = await WebAssembly.instantiate(module, importObject);
      processInstance = instance;

      setupChannelBase(instance, memory, channelOffset, programBytes as ArrayBuffer);

      port.postMessage({ type: "ready", pid } satisfies WorkerToHostMessage);

      let exitCode = 0;
      try {
        const start = instance.exports._start as (() => void) | undefined;
        if (start) start();
      } catch (e) {
        if (e instanceof Error && e.message.includes("unreachable")) {
          exitCode = 0;
        } else {
          throw e;
        }
      }

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

    // Pattern 1: direct export — starts with i32.const <offset>
    if (src[pos] === 0x41) {
      pos++;
      const [tlsOffset] = readLEB128(src, pos);
      return tlsOffset;
    }

    // Pattern 3: post-asyncify — global.get <tls_base>; i32.const <offset>; i32.add
    if (src[pos] === 0x23) {
      let p3 = pos + 1;
      const [, globalIdxBytes] = readLEB128(src, p3); p3 += globalIdxBytes;
      if (src[p3] === 0x41) {
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

    if (src[pos2] !== 0x41) return -1;
    pos2++;
    const [tlsOffset] = readLEB128(src, pos2);
    return tlsOffset;
  }

  return -1;
}

function setupChannelBase(
  instance: WebAssembly.Instance,
  memory: WebAssembly.Memory,
  channelOffset: number,
  programBytes?: ArrayBuffer,
): void {
  const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
  const view = new DataView(memory.buffer);

  const tlsAddr = tlsBase ? (tlsBase.value as number) : 0;

  // Try to detect the exact TLS offset of __channel_base from the binary.
  // This avoids corrupting other TLS variables during constructor execution.
  let detectedOffset = -1;
  let savedTlsValue = 0;
  if (programBytes) {
    detectedOffset = detectChannelBaseTlsOffset(programBytes);
  }

  if (tlsAddr > 0 && detectedOffset >= 0) {
    // We know the exact offset — pre-set it before calling the export.
    // This avoids the chicken-and-egg problem: the export wrapper runs
    // __wasm_call_ctors which may call malloc/brk, but __channel_base
    // is already set at the correct TLS location.
    view.setUint32(tlsAddr + detectedOffset, channelOffset, true);
  } else if (tlsAddr > 0) {
    // Fallback: set at offset 0 (works for programs where __channel_base
    // happens to be the first TLS variable). Save original value for restore.
    savedTlsValue = view.getUint32(tlsAddr, true);
    view.setUint32(tlsAddr, channelOffset, true);
  }

  // Call __get_channel_base_addr to confirm the address and trigger ctors.
  const getChannelBaseAddr = instance.exports.__get_channel_base_addr as (() => number) | undefined;
  if (getChannelBaseAddr) {
    const addr = getChannelBaseAddr();
    view.setUint32(addr, channelOffset, true);
    // If we set at offset 0 as fallback and the real offset is different,
    // restore offset 0 to its original value
    if (detectedOffset < 0 && addr !== tlsAddr && tlsAddr > 0) {
      view.setUint32(tlsAddr, savedTlsValue, true);
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
): void {
  const view = new DataView(memory.buffer);

  const tlsBaseGlobal = instance.exports.__tls_base as WebAssembly.Global | undefined;
  if (tlsBaseGlobal) {
    const tlsBase = tlsBaseGlobal.value as number;
    if (tlsBase > 0) {
      view.setUint32(asyncifyBufAddr - 4, tlsBase, true);
    }
  }

  const stackPtrGlobal = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
  if (stackPtrGlobal) {
    const stackPtr = stackPtrGlobal.value as number;
    if (stackPtr > 0) {
      view.setUint32(asyncifyBufAddr - 8, stackPtr, true);
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
  const CH_RETURN = 32;
  const CH_ERRNO = 36;

  const view = new DataView(memory.buffer);
  view.setInt32(channelOffset + CH_SYSCALL, SYS_FORK_NR, true);
  for (let i = 0; i < 6; i++) {
    view.setInt32(channelOffset + CH_ARGS + i * 4, 0, true);
  }

  const i32 = new Int32Array(memory.buffer);
  Atomics.store(i32, channelOffset / 4, 1); // CH_PENDING
  Atomics.notify(i32, channelOffset / 4, 1);
  while (Atomics.wait(i32, channelOffset / 4, 1) === "ok") { /* */ }

  const result = view.getInt32(channelOffset + CH_RETURN, true);
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

  if (ctorFuncIndex < 0) {
    console.error(`[patchWasmForThread] could not find ctor function; exports=${exportedFuncIndices}`);
    return bytes;
  }

  const ctorCodeEntry = ctorFuncIndex - numFuncImports;
  console.error(`[patchWasmForThread] ctor=func ${ctorFuncIndex} (code entry ${ctorCodeEntry}), numFuncImports=${numFuncImports}`);
  if (ctorCodeEntry < 0) return bytes; // Constructor is an import?

  // Build output: skip Start section, neuter constructor function in Code section
  const chunks: Uint8Array[] = [];
  chunks.push(src.subarray(0, 8)); // Wasm header

  for (const sec of sections) {
    if (sec.id === 8) {
      continue; // Skip start section
    }

    if (sec.id === 10) {
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

  try {
    // Debug logging removed — pollutes stderr for output-based tests

    // Strip the start section AND neuter the constructor function body to prevent
    // constructors from re-running. Thread instances share memory with the main
    // thread; re-running constructors would clobber global state.
    const programBytes = initData.programModule
      ? null
      : patchWasmForThread(initData.programBytes);
    const module = initData.programModule
      ? initData.programModule
      : new WebAssembly.Module(programBytes!);
    // Debug logging removed — pollutes stderr for output-based tests

    const kernelImports = buildKernelImports(memory, channelOffset);
    const importObject = buildImportObject(module, memory, kernelImports);
    const instance = new WebAssembly.Instance(module, importObject);

    // Initialize Wasm TLS for this thread using the pre-allocated address.
    // __wasm_init_tls copies template data AND sets __tls_base to the given address.
    const wasmInitTls = instance.exports.__wasm_init_tls as ((addr: number) => void) | undefined;
    const tlsBlock = tlsAllocAddr;

    if (wasmInitTls && tlsBlock > 0) {
      wasmInitTls(tlsBlock);
    }

    // Set __stack_pointer
    const stackPointer = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
    if (stackPointer) {
      stackPointer.value = stackPtr;
    }

    // Initialize musl thread pointer if available
    const wasmThreadInit = instance.exports.__wasm_thread_init as ((tp: number) => void) | undefined;
    if (wasmThreadInit && tlsPtr > 0) {
      wasmThreadInit(tlsPtr);
    }

    // Set __channel_base in TLS using the exported helper to find its actual address,
    // since __channel_base may not be at offset 0 from __tls_base if the program
    // has its own _Thread_local variables.
    const getChannelBaseAddr = instance.exports.__get_channel_base_addr as (() => number) | undefined;
    if (getChannelBaseAddr) {
      const addr = getChannelBaseAddr();
      const view = new DataView(memory.buffer);
      view.setUint32(addr, channelOffset, true);
    } else if (tlsBlock > 0) {
      // Fallback: assume offset 0 (only for programs without the helper)
      const view = new DataView(memory.buffer);
      view.setUint32(tlsBlock, channelOffset, true);
    }

    // Call the thread function via indirect function table
    const table = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
    if (!table) {
      throw new Error("No __indirect_function_table export — cannot call thread function");
    }

    const threadFn = table.get(fnPtr) as ((arg: number) => number) | null;
    if (!threadFn) {
      throw new Error(`Thread function at table index ${fnPtr} is null`);
    }

    let result: number;
    console.error(`[thread-worker] tid=${tid} calling threadFn(${argPtr})...`);
    try {
      result = threadFn(argPtr);
      console.error(`[thread-worker] tid=${tid} threadFn returned ${result}`);
    } catch (e) {
      console.error(`[thread-worker] tid=${tid} threadFn threw:`, e);
      if (e instanceof Error && e.message.includes("unreachable")) {
        // Thread exited via kernel_exit → unreachable trap
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
    console.error(`[thread-worker] tid=${tid} CAUGHT ERROR:`, err);
    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  }
}
