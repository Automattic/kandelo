/**
 * run-hello.ts — End-to-end integration test for hello world.
 *
 * Loads the kernel Wasm module, then instantiates hello.wasm (a C program
 * compiled via musl + our syscall glue) and runs it.
 *
 * Expected output: "Hello from musl on wasm-posix-kernel!"
 * Expected exit code: 0
 *
 * Usage:
 *   npx tsx --tsconfig host/tsconfig.json examples/run-hello.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { WasmPosixKernel } from "../host/src/kernel";
import { ProgramRunner } from "../host/src/program-runner";
import { NodePlatformIO } from "../host/src/platform/node";

async function main() {
    // Resolve paths relative to the repo root (cwd).
    const kernelPath = resolve("host/wasm/wasm_posix_kernel.wasm");
    const programPath = resolve("examples/hello.wasm");

    console.log("Loading kernel from:", kernelPath);
    console.log("Loading program from:", programPath);

    const kernelBytes = readFileSync(kernelPath);
    const programBytes = readFileSync(programPath);

    // Create and initialize the kernel.
    const io = new NodePlatformIO();
    const kernel = new WasmPosixKernel({}, io);
    await kernel.init(kernelBytes);
    console.log("Kernel initialized.");

    // Run the program.
    const runner = new ProgramRunner(kernel);
    console.log("Running hello.wasm...\n---");
    const exitCode = await runner.run(programBytes);
    console.log("---");
    console.log(`Program exited with code ${exitCode}`);
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
