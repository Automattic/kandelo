/**
 * run-example.ts — Run any compiled .wasm example on the kernel.
 *
 * Uses ProcessManager with worker threads so fork/exec/posix_spawn work.
 *
 * Usage:
 *   npx tsx examples/run-example.ts <name>
 *
 * Example:
 *   npx tsx examples/run-example.ts hello
 *   npx tsx examples/run-example.ts /path/to/test.wasm
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { ProcessManager } from "../host/src/process-manager";
import { NodeWorkerAdapter } from "../host/src/worker-adapter";

// Built-in program resolution: resolve exec paths to .wasm binaries.
// Searches: examples/<name>.wasm, then absolute path.
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const builtinPrograms: Record<string, string> = {
    "echo": resolve(repoRoot, "examples/echo.wasm"),
    "/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "/usr/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "sh": resolve(repoRoot, "host/wasm/sh.wasm"),
    "/bin/sh": resolve(repoRoot, "host/wasm/sh.wasm"),
};

function resolveProgram(path: string): Promise<ArrayBuffer | null> {
    // Check built-in mappings first
    const mapped = builtinPrograms[path];
    if (mapped && existsSync(mapped)) {
        const bytes = readFileSync(mapped);
        return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    // Try as a file path
    const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(repoRoot, `examples/${path}.wasm`),
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            const bytes = readFileSync(c);
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        }
    }
    return Promise.resolve(null);
}

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

    const pm = new ProcessManager({
        wasmBytes: kernelBytes.buffer.slice(
            kernelBytes.byteOffset,
            kernelBytes.byteOffset + kernelBytes.byteLength,
        ),
        kernelConfig: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
        workerAdapter: new NodeWorkerAdapter(),
        resolveProgram,
    });

    const pid = await pm.spawn({
        env: Object.entries(process.env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`),
        argv: [programPath, ...process.argv.slice(3)],
        programBytes: programBytes.buffer.slice(
            programBytes.byteOffset,
            programBytes.byteOffset + programBytes.byteLength,
        ),
    });

    const result = await pm.waitpid(pid);
    process.exit(result.status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
