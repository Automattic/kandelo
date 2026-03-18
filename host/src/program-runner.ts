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
 */

import { WasmPosixKernel } from "./kernel";

// Enable exnref for Node.js < 25 (browsers already support it natively)
if (typeof process !== "undefined" && process.versions?.node) {
  import("node:v8")
    .then(v8 => v8.setFlagsFromString("--experimental-wasm-exnref"))
    .catch(() => {});
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
        // This must happen before program instantiation because the program's
        // start section (__wasm_call_ctors) runs during instantiate, and while
        // it typically doesn't call kernel functions, we ensure kernel state
        // is ready just in case.
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
        // The start section (__wasm_call_ctors) runs automatically during
        // instantiation, setting up C global constructors.
        const module = await WebAssembly.compile(programBytes);

        // Ensure shared memory has enough pages for the program's declared minimum.
        // Large programs (e.g. PHP) may need more initial pages than the kernel allocates.
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

        // Build env imports: memory + stub any unresolved function imports.
        // Programs compiled with --allow-undefined may import functions that
        // don't exist in the kernel (e.g. DNS, fibers). Stub them to trap.
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

        // Give the kernel access to the program's function table so signal
        // handlers (registered via sigaction in user code) can be dispatched.
        const progTable = instance.exports.__indirect_function_table as WebAssembly.Table | undefined;
        if (progTable) {
            this.kernel.setProgramFuncTable(progTable);
        }

        // Set the kernel's program break to the program's __heap_base.
        // Without this, the kernel uses a default break (16MB) which may
        // be beyond the allocated Wasm memory, causing OOB errors on malloc.
        const heapBase = instance.exports.__heap_base;
        if (heapBase instanceof WebAssembly.Global) {
            const kernelBrk = kernelExports.kernel_brk as Function;
            kernelBrk(heapBase.value);
        }

        // Call the program's _start entry point.
        const startFn = instance.exports._start as Function;
        const getExitStatus = kernelExports.kernel_get_exit_status as Function | undefined;
        try {
            startFn();
            return 0;
        } catch (e: unknown) {
            // kernel_exit calls wasm unreachable to unwind the stack.
            // This manifests as a RuntimeError with "unreachable" in the message.
            // We treat this as a normal program exit and read the stored exit code.
            if (e instanceof WebAssembly.RuntimeError) {
                const msg = e.message || "";
                if (msg.includes("unreachable")) {
                    return getExitStatus ? getExitStatus() : 0;
                }
            }
            throw e;
        }
    }
}
