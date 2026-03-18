/**
 * run-example.ts — Run any compiled .wasm example on the kernel.
 *
 * Usage:
 *   npx tsx examples/run-example.ts <name>
 *
 * Example:
 *   npx tsx examples/run-example.ts hello
 *   npx tsx examples/run-example.ts /path/to/test.wasm
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

    const kernel = new WasmPosixKernel(
        { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
        io,
        {
            onStdout: (data) => process.stdout.write(data),
            onStderr: (data) => process.stderr.write(data),
        },
    );

    await kernel.init(kernelBytes);

    const runner = new ProgramRunner(kernel);
    const exitCode = await runner.run(programBytes, {
        env: Object.entries(process.env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`),
        argv: [programPath, ...process.argv.slice(3)],
    });

    process.exit(exitCode);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
