/**
 * run-example.ts — Run any compiled .wasm example on the kernel.
 *
 * Usage:
 *   npx tsx examples/run-example.ts <name>
 *
 * Example:
 *   npx tsx examples/run-example.ts hello
 *   npx tsx examples/run-example.ts malloc
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { WasmPosixKernel } from "../host/src/kernel";
import { ProgramRunner } from "../host/src/program-runner";
import { NodePlatformIO } from "../host/src/platform/node";

async function main() {
    const name = process.argv[2];
    if (!name) {
        console.error("Usage: npx tsx examples/run-example.ts <name>");
        console.error("  e.g. hello, fprintf, strings, math, malloc, files, dirs, snprintf, environ");
        process.exit(1);
    }

    const kernelPath = resolve("host/wasm/wasm_posix_kernel.wasm");
    // Support both bare names (from examples/) and full paths
    const programPath = name.endsWith(".wasm")
        ? resolve(name)
        : resolve(`examples/${name}.wasm`);

    const kernelBytes = readFileSync(kernelPath);
    const programBytes = readFileSync(programPath);

    const io = new NodePlatformIO();
    const kernel = new WasmPosixKernel({}, io);
    await kernel.init(kernelBytes);

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(programBytes);

    if (exitCode !== 0) {
        console.error(`\nExited with code ${exitCode}`);
        process.exit(exitCode);
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
