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
        const kernelImports: Record<string, WebAssembly.ExportValue> = {};
        for (const [name, exp] of Object.entries(kernelExports)) {
            if (name.startsWith("kernel_") && typeof exp === "function") {
                kernelImports[name] = exp;
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

        // Call the program's _start entry point.
        const startFn = instance.exports._start as Function;
        try {
            startFn();
            return 0;
        } catch (e: unknown) {
            // kernel_exit calls wasm unreachable to unwind the stack.
            // This manifests as a RuntimeError with "unreachable" in the message.
            // We treat this as a normal program exit.
            if (e instanceof WebAssembly.RuntimeError) {
                const msg = e.message || "";
                if (msg.includes("unreachable")) {
                    return 0;
                }
            }
            throw e;
        }
    }
}
