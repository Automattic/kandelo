/**
 * ProgramRunner — Two-module instantiation for running user programs.
 *
 * Instantiates a user program (compiled C→Wasm via musl) and bridges
 * kernel exports as program imports. Both modules share the same
 * WebAssembly.Memory.
 *
 * The user program imports:
 *   - kernel.kernel_* — syscall functions exported by the kernel module
 *   - env.memory     — shared linear memory from the kernel module
 *
 * Lifecycle:
 *   1. kernel_init(pid) on the kernel instance
 *   2. WebAssembly.instantiate(program) — runs __wasm_call_ctors via start section
 *   3. Call program's _start export
 *   4. Catch unreachable trap from kernel_exit as clean exit
 *
 * Asyncify support (optional):
 *   If the user program was built with `wasm-opt --asyncify`, fork() can
 *   save/restore the call stack so the child resumes from the fork return
 *   point instead of restarting at _start. This is the initial mechanism;
 *   it can be replaced by Wasm Stack Switching or JSPI in the future.
 */

import { WasmPosixKernel } from "./kernel";

// Enable exnref for Node.js < 25 (browsers already support it natively).
// Must be synchronous — async import() can race with WebAssembly.compile().
if (typeof process !== "undefined" && process.versions?.node) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require("node:module") as typeof import("node:module");
    const v8 = createRequire(import.meta.url)("node:v8") as typeof import("node:v8");
    v8.setFlagsFromString("--experimental-wasm-exnref");
  } catch {
    // Ignore — browser or unsupported Node version
  }
}

/** Size of the asyncify data buffer (1 page). */
export const ASYNCIFY_DATA_SIZE = 65536;

/**
 * Callback interface for handling fork() when Asyncify is available.
 * The program runner calls this after capturing the asyncify stack data.
 * The handler is responsible for taking a memory snapshot, serializing
 * kernel state, sending fork_request, and blocking until the child is created.
 */
export interface AsyncifyForkHandler {
  handleFork(
    asyncifyData: ArrayBuffer,
    asyncifyDataAddr: number,
    memory: WebAssembly.Memory,
  ): number; // Returns child PID (>0) or negative errno
}

/**
 * Data needed to resume a fork child from the parent's fork point.
 * The child restores memory, writes asyncify data, and rewinds to the
 * fork() call site where it returns 0.
 */
export interface AsyncifyResumeData {
  memorySnapshot: ArrayBuffer;
  asyncifyData: ArrayBuffer;
  asyncifyDataAddr: number;
  childPid: number;
}

/** Read an unsigned LEB128 integer from a byte array. */
function readLEB128(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;
    while (true) {
        const byte = bytes[offset + bytesRead];
        value |= (byte & 0x7f) << shift;
        bytesRead++;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value, bytesRead };
}

/**
 * Parse a Wasm binary's import section to find the minimum memory pages
 * required by a memory import. Returns null if no memory import is found.
 */
function getMemoryImportMinPages(bytes: Uint8Array): number | null {
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 ||
        bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        return null;
    }
    let offset = 8; // skip magic + version
    while (offset < bytes.length) {
        const sectionId = bytes[offset++];
        const size = readLEB128(bytes, offset);
        offset += size.bytesRead;
        if (sectionId !== 2) { // not import section
            offset += size.value;
            continue;
        }
        const sectionEnd = offset + size.value;
        const numImports = readLEB128(bytes, offset);
        offset += numImports.bytesRead;
        for (let i = 0; i < numImports.value && offset < sectionEnd; i++) {
            // skip module name
            const modLen = readLEB128(bytes, offset);
            offset += modLen.bytesRead + modLen.value;
            // skip field name
            const fieldLen = readLEB128(bytes, offset);
            offset += fieldLen.bytesRead + fieldLen.value;
            const kind = bytes[offset++];
            if (kind === 2) { // memory import
                const _flags = bytes[offset++];
                const min = readLEB128(bytes, offset);
                return min.value;
            } else if (kind === 0) { // function
                const t = readLEB128(bytes, offset);
                offset += t.bytesRead;
            } else if (kind === 1) { // table
                offset++; // elemtype
                const flags = bytes[offset++];
                const min = readLEB128(bytes, offset);
                offset += min.bytesRead;
                if (flags & 1) {
                    const max = readLEB128(bytes, offset);
                    offset += max.bytesRead;
                }
            } else if (kind === 3) { // global
                offset += 2; // valtype + mut
            }
        }
        return null;
    }
    return null;
}

/** Extract exit code from a _start() trap. Returns the code or rethrows. */
function handleExitTrap(
    e: unknown,
    getExitStatus: Function | undefined,
): number {
    if (e instanceof WebAssembly.RuntimeError) {
        const msg = e.message || "";
        if (msg.includes("unreachable")) {
            const status = getExitStatus ? getExitStatus() : 0;
            return status;
        }
    }
    throw e;
}

/**
 * Instantiate and run a user program on an already-initialized kernel.
 * The kernel must have been init'd (kernel_init or kernel_init_from_fork/exec)
 * and env/argv must already be set.
 *
 * @param options.forkHandler  - Asyncify fork callback (parent side)
 * @param options.resumeFromFork - Asyncify resume data (child side)
 * @returns The exit code (0 for normal exit via kernel_exit trap)
 */
export async function instantiateAndRunProgram(
    kernel: WasmPosixKernel,
    programBytes: BufferSource,
    options?: {
      forkHandler?: AsyncifyForkHandler;
      resumeFromFork?: AsyncifyResumeData;
    },
): Promise<number> {
    const memory = kernel.getMemory();
    if (!memory) throw new Error("Kernel not initialized");

    const kernelInstance = kernel.getInstance();
    if (!kernelInstance) throw new Error("Kernel not initialized");

    const kernelExports = kernelInstance.exports;

    // Build import object bridging kernel exports to program imports.
    const trace = typeof process !== "undefined" && !!process.env?.TRACE_SYSCALLS;
    const kernelImports: Record<string, WebAssembly.ExportValue> = {};
    for (const [name, exp] of Object.entries(kernelExports)) {
        if (name.startsWith("kernel_") && typeof exp === "function") {
            if (trace) {
                const fn = exp as Function;
                kernelImports[name] = (...args: unknown[]) => {
                    const result = fn(...args);
                    console.error(`[trace] ${name}(${args.map(a => typeof a === 'bigint' ? `${a}n` : a).join(', ')}) => ${typeof result === 'bigint' ? `${result}n` : result}`);
                    return result;
                };
            } else {
                kernelImports[name] = exp;
            }
        }
    }

    // Compile and instantiate the program module.
    const module = await WebAssembly.compile(programBytes);

    // Ensure shared memory has enough pages for the program's declared minimum.
    const programBuf = programBytes instanceof ArrayBuffer
        ? new Uint8Array(programBytes)
        : new Uint8Array((programBytes as ArrayBufferView).buffer,
            (programBytes as ArrayBufferView).byteOffset,
            (programBytes as ArrayBufferView).byteLength);
    const requiredPages = getMemoryImportMinPages(programBuf);
    if (requiredPages !== null) {
        const currentPages = memory.buffer.byteLength / 65536;
        if (currentPages < requiredPages) {
            memory.grow(requiredPages - currentPages);
        }
    }

    // Detect asyncify support in the compiled module.
    const moduleExportList = WebAssembly.Module.exports(module);
    const hasAsyncify = moduleExportList.some(e => e.name === "asyncify_start_unwind");
    const useAsyncifyFork = hasAsyncify && !!(options?.forkHandler || options?.resumeFromFork);

    // Asyncify state: mutable ref so the kernel_fork wrapper (defined before
    // the instance exists) can call asyncify_start_unwind on it.
    let programInst: WebAssembly.Instance | null = null;
    let forkResult = 0;
    let asyncifyDataAddr = 0;

    if (useAsyncifyFork) {
        // Replace kernel_fork import with asyncify-aware wrapper.
        // Normal (non-rewind) calls trigger asyncify unwind to capture the stack.
        // During rewind, return the fork result (child PID or 0).
        kernelImports["kernel_fork"] = () => {
            if (!programInst) return -38; // -ENOSYS

            // Check asyncify state: 2 = rewinding → return fork result
            const state = (programInst.exports.asyncify_get_state as Function)();
            if (state === 2) {
                return forkResult;
            }

            // Normal call: set up data buffer and start unwind
            const view = new DataView(memory.buffer);
            view.setUint32(asyncifyDataAddr, asyncifyDataAddr + 8, true);     // data start
            view.setUint32(asyncifyDataAddr + 4, asyncifyDataAddr + ASYNCIFY_DATA_SIZE, true); // data end
            (programInst.exports.asyncify_start_unwind as Function)(asyncifyDataAddr);
            return 0; // discarded during unwind
        };
    }

    // Build env imports: memory + stub any unresolved function imports.
    const envImports: Record<string, WebAssembly.ExportValue> = { memory };
    for (const imp of WebAssembly.Module.imports(module)) {
        if (imp.module === "env" && imp.kind === "function") {
            envImports[imp.name] = () => {
                throw new Error(`Unimplemented import: env.${imp.name}`);
            };
        }
    }

    const importObject: WebAssembly.Imports = {
        kernel: kernelImports,
        env: envImports,
    };

    const instance = await WebAssembly.instantiate(module, importObject);
    programInst = instance;

    // Give the kernel access to the program's function table so signal
    // handlers (registered via sigaction in user code) can be dispatched.
    const progTable = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
    if (progTable) {
        kernel.setProgramFuncTable(progTable);
    }

    // ── Child resume path (asyncify rewind) ──────────────────────────
    if (options?.resumeFromFork && hasAsyncify) {
        const resume = options.resumeFromFork;
        // Grow memory to match snapshot size, then overwrite with parent's state.
        const snapshotSize = resume.memorySnapshot.byteLength;
        const currentSize = memory.buffer.byteLength;
        if (snapshotSize > currentSize) {
            memory.grow(Math.ceil((snapshotSize - currentSize) / 65536));
        }
        new Uint8Array(memory.buffer, 0, snapshotSize).set(
            new Uint8Array(resume.memorySnapshot),
        );

        // Kernel state in memory is now the parent's. Fix PID.
        (kernelExports.kernel_set_child_pid as Function)(resume.childPid);

        // Restore asyncify data from parent's snapshot.
        // Important: do NOT reset the position pointer [addr+0]. Asyncify
        // reads BACKWARD during rewind, so the position must remain at
        // the end of the written data (where unwind finished writing).
        asyncifyDataAddr = resume.asyncifyDataAddr;
        new Uint8Array(memory.buffer, asyncifyDataAddr, resume.asyncifyData.byteLength)
            .set(new Uint8Array(resume.asyncifyData));

        // Rewind to fork point; kernel_fork wrapper will return 0.
        forkResult = 0;
        (instance.exports.asyncify_start_rewind as Function)(asyncifyDataAddr);

        // Fall through to the asyncify execution loop below.
    }

    // ── Normal parent setup ──────────────────────────────────────────
    if (!options?.resumeFromFork) {
        // Set the kernel's program break to the program's __heap_base.
        const heapBase = instance.exports.__heap_base;
        if (heapBase instanceof WebAssembly.Global) {
            (kernelExports.kernel_brk as Function)(heapBase.value);
        }

        // Allocate asyncify data buffer (1 page) right after program heap.
        if (useAsyncifyFork) {
            const allocPage = memory.grow(1);
            asyncifyDataAddr = allocPage * 65536;
        }
    }

    // ── Simple execution (no asyncify) ───────────────────────────────
    const startFn = instance.exports._start as Function;
    const getExitStatus = kernelExports.kernel_get_exit_status as Function | undefined;

    if (!useAsyncifyFork) {
        try {
            startFn();
            return 0;
        } catch (e: unknown) {
            return handleExitTrap(e, getExitStatus);
        }
    }

    // ── Asyncify execution loop ──────────────────────────────────────
    // Handles: normal run, fork-triggered unwind, parent rewind, child
    // rewind, and nested forks. Uses asyncify_get_state to determine
    // what happened after _start() returns.
    const getAsyncifyState = instance.exports.asyncify_get_state as Function;

    while (true) {
        let exitCode: number;
        try {
            startFn();
            exitCode = 0;
        } catch (e: unknown) {
            exitCode = handleExitTrap(e, getExitStatus);
        }

        const state = getAsyncifyState() as number;

        if (state === 1) {
            // Unwinding: fork() was called and stack has been saved.
            (instance.exports.asyncify_stop_unwind as Function)();

            // Capture asyncify data before the fork handler modifies memory.
            const savedAsyncData = new Uint8Array(
                memory.buffer, asyncifyDataAddr, ASYNCIFY_DATA_SIZE,
            ).slice().buffer;

            // Delegate fork to the handler (pipe conversion, memory snapshot,
            // fork_request, Atomics.wait, etc.)
            const childPid = options!.forkHandler!.handleFork(
                savedAsyncData, asyncifyDataAddr, memory,
            );
            forkResult = childPid;

            // Restore asyncify data (handler may have modified memory).
            // Important: do NOT reset the position pointer [addr+0]. Asyncify
            // reads BACKWARD during rewind, so the position must remain at
            // the end of the written data (where unwind finished writing).
            new Uint8Array(memory.buffer, asyncifyDataAddr, ASYNCIFY_DATA_SIZE)
                .set(new Uint8Array(savedAsyncData));

            // Rewind parent: re-call _start, which rewinds to the fork point
            // and kernel_fork wrapper returns childPid.
            (instance.exports.asyncify_start_rewind as Function)(asyncifyDataAddr);
            continue;
        }

        if (state === 2) {
            // Rewind completed: _start ran forward from fork point to exit.
            (instance.exports.asyncify_stop_rewind as Function)();
        }

        // state === 0: normal exit (no asyncify activity).
        return exitCode;
    }
}

export class ProgramRunner {
    private kernel: WasmPosixKernel;

    constructor(kernel: WasmPosixKernel) {
        this.kernel = kernel;
    }

    /**
     * Run a user program to completion.
     *
     * @param programBytes - The compiled Wasm bytes of the user program
     * @param options - Optional settings (env: KEY=VALUE strings, argv: argument strings)
     * @returns The exit code (0 for normal exit via kernel_exit trap)
     */
    async run(programBytes: BufferSource, options?: { env?: string[]; argv?: string[] }): Promise<number> {
        const memory = this.kernel.getMemory();
        if (!memory) throw new Error("Kernel not initialized");

        const kernelInstance = this.kernel.getInstance();
        if (!kernelInstance) throw new Error("Kernel not initialized");

        const kernelExports = kernelInstance.exports;

        // Initialize kernel process state for PID 1.
        const kernelInit = kernelExports.kernel_init as Function;
        kernelInit(1);

        // Allocate a scratch page for writing strings into wasm memory
        const needsScratch = (options?.env && options.env.length > 0)
            || (options?.argv && options.argv.length > 0);
        let scratchPtr = 0;
        if (needsScratch) {
            const scratchPage = memory.grow(1);
            scratchPtr = scratchPage * 65536;
        }
        const encoder = new TextEncoder();

        // Set environment variables if provided
        if (options?.env && options.env.length > 0) {
            const setenv = kernelExports.kernel_setenv as Function;
            for (const entry of options.env) {
                const eq = entry.indexOf("=");
                if (eq < 0) continue;
                const nameBytes = encoder.encode(entry.slice(0, eq));
                const valBytes = encoder.encode(entry.slice(eq + 1));
                const buf = new Uint8Array(memory.buffer);
                const valPtr = scratchPtr + nameBytes.length;
                buf.set(nameBytes, scratchPtr);
                buf.set(valBytes, valPtr);
                setenv(scratchPtr, nameBytes.length, valPtr, valBytes.length, 1);
            }
        }

        // Push argv if provided
        if (options?.argv && options.argv.length > 0) {
            const pushArgv = kernelExports.kernel_push_argv as Function;
            for (const arg of options.argv) {
                const bytes = encoder.encode(arg);
                const buf = new Uint8Array(memory.buffer);
                buf.set(bytes, scratchPtr);
                pushArgv(scratchPtr, bytes.length);
            }
        }

        return instantiateAndRunProgram(this.kernel, programBytes);
    }
}
