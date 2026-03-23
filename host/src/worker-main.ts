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
      console.error(`[kernel_clone] fnPtr=${fnPtr} stackPtr=${stackPtr} flags=0x${flags.toString(16)} arg=${arg} ptidPtr=${ptidPtr} tlsPtr=${tlsPtr} ctidPtr=${ctidPtr}`);
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
 * Build import object for a Wasm module, stubbing unresolved imports.
 */
function buildImportObject(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  kernelImports: Record<string, WebAssembly.ExportValue>,
): WebAssembly.Imports {
  const envImports: Record<string, WebAssembly.ExportValue> = { memory };

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

/**
 * Main process worker entry point.
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  try {
    const { memory, programBytes, channelOffset, pid } = initData;

    const module = await WebAssembly.compile(programBytes);
    const kernelImports = buildKernelImports(
      memory, channelOffset, initData.argv || [], initData.env || [],
    );
    const importObject = buildImportObject(module, memory, kernelImports);
    const instance = await WebAssembly.instantiate(module, importObject);

    // Set __channel_base in TLS so __do_syscall knows where the channel is.
    // Use the exported helper to find __channel_base's actual address in TLS,
    // since it may not be at offset 0 if the program has its own _Thread_local vars.
    const getChannelBaseAddr = instance.exports.__get_channel_base_addr as (() => number) | undefined;
    if (getChannelBaseAddr) {
      const addr = getChannelBaseAddr();
      const view = new DataView(memory.buffer);
      view.setUint32(addr, channelOffset, true);
    } else {
      // Fallback for programs without the helper (shouldn't happen with current glue)
      const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
      if (tlsBase) {
        const view = new DataView(memory.buffer);
        view.setUint32(tlsBase.value as number, channelOffset, true);
      }
    }

    // Signal ready
    port.postMessage({
      type: "ready",
      pid,
    } satisfies WorkerToHostMessage);

    // Run the program
    let exitCode = 0;
    try {
      const start = instance.exports._start as (() => void) | undefined;
      if (start) {
        start();
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("unreachable")) {
        // Normal exit via kernel_exit → unreachable trap
        exitCode = 0;
      } else {
        throw e;
      }
    }

    port.postMessage({
      type: "exit",
      pid,
      status: exitCode,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Centralized worker failed: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies WorkerToHostMessage);
  }
}

/**
 * Thread worker entry point for centralized mode.
 *
 * Threads share the parent process's Memory. This function:
 * 1. Instantiates the same Wasm module with shared memory
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
    const module = initData.programModule
      ? initData.programModule
      : new WebAssembly.Module(initData.programBytes);

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
    try {
      result = threadFn(argPtr);
    } catch (e) {
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
    port.postMessage({
      type: "thread_exit",
      pid,
      tid,
    } satisfies WorkerToHostMessage);
  }
}
