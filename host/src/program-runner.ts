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
  try {
    const v8 = await import("node:v8");
    v8.setFlagsFromString("--experimental-wasm-exnref");
  } catch {
    // v8 module unavailable
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
     * @returns The exit code (0 for normal exit via kernel_exit trap)
     */
    async run(programBytes: BufferSource): Promise<number> {
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

        // Build import object bridging kernel exports to program imports.
        const trace = !!process?.env?.TRACE_SYSCALLS;
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

        const importObject: WebAssembly.Imports = {
            kernel: kernelImports,
            env: { memory },
        };

        // Compile and instantiate the program module.
        // The start section (__wasm_call_ctors) runs automatically during
        // instantiation, setting up C global constructors.
        const module = await WebAssembly.compile(programBytes);
        const instance = await WebAssembly.instantiate(module, importObject);

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
