/**
 * run-example.ts — Run any compiled .wasm example on the kernel.
 *
 * Uses CentralizedKernelWorker + centralizedWorkerMain so all syscalls
 * go through a single kernel instance via channel IPC.
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
import { CentralizedKernelWorker } from "../host/src/kernel-worker";
import { NodePlatformIO } from "../host/src/platform/node";
import { NodeWorkerAdapter } from "../host/src/worker-adapter";
import type { WorkerHandle } from "../host/src/worker-adapter";
import type { CentralizedWorkerInitMessage, WorkerToHostMessage } from "../host/src/worker-protocol";

const CH_TOTAL_SIZE = 40 + 65536; // header (40B) + data buffer (64KB)

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const workerAdapter = new NodeWorkerAdapter();

// Built-in program resolution
const builtinPrograms: Record<string, string> = {
    "echo": resolve(repoRoot, "examples/echo.wasm"),
    "/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "/usr/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "sh": resolve(repoRoot, "host/wasm/sh.wasm"),
    "/bin/sh": resolve(repoRoot, "host/wasm/sh.wasm"),
};

function resolveProgram(path: string): ArrayBuffer | null {
    const mapped = builtinPrograms[path];
    if (mapped && existsSync(mapped)) {
        const bytes = readFileSync(mapped);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(repoRoot, `examples/${path}.wasm`),
    ];
    for (const c of candidates) {
        if (existsSync(c)) {
            const bytes = readFileSync(c);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
    }
    return null;
}

async function main() {
    const name = process.argv[2];
    if (!name) {
        console.error("Usage: npx tsx examples/run-example.ts <name>");
        process.exit(1);
    }

    const kernelPath = resolve("host/wasm/wasm_posix_kernel.wasm");
    const programPath = name.endsWith(".wasm")
        ? resolve(name)
        : resolve(`examples/${name}.wasm`);

    const kernelBytes = readFileSync(kernelPath);
    const programBytes = readFileSync(programPath);

    const io = new NodePlatformIO();

    // Track process exits
    const processExits = new Map<number, { resolve: (status: number) => void }>();

    function setupChildWorkerHandlers(worker: WorkerHandle, pid: number) {
        worker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                const entry = processExits.get(m.pid);
                if (entry) {
                    entry.resolve(m.status);
                }
                kernelWorker.unregisterProcess(m.pid);
                worker.terminate().catch(() => {});
            }
        });
        worker.on("error", () => {
            const entry = processExits.get(pid);
            if (entry) {
                entry.resolve(1);
            }
            kernelWorker.unregisterProcess(pid);
        });
    }

    // Create the centralized kernel worker
    const kernelWorker = new CentralizedKernelWorker(
        { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
        io,
        {
            onFork: async (parentPid, childPid, parentMemory) => {
                // Copy parent memory to create child.
                // Parent memory is already at max pages, so child should be too.
                const parentBuf = new Uint8Array(parentMemory.buffer);
                const parentPages = Math.ceil(parentBuf.byteLength / 65536);
                const childMemory = new WebAssembly.Memory({
                    initial: parentPages,
                    maximum: MAX_PAGES,
                    shared: true,
                });
                // Grow child to same size as parent
                if (parentPages < MAX_PAGES) {
                    childMemory.grow(MAX_PAGES - parentPages);
                }
                new Uint8Array(childMemory.buffer).set(parentBuf);

                // Channel at same offset as parent (last 2 pages)
                const childChannelOffset = (MAX_PAGES - 2) * 65536;
                new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

                // Register child with kernel (skip kernel_create_process — already forked)
                kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

                // Spawn child worker
                const childInitData: CentralizedWorkerInitMessage = {
                    type: "centralized_init",
                    pid: childPid,
                    ppid: parentPid,
                    programBytes: programBytes.buffer.slice(
                        programBytes.byteOffset,
                        programBytes.byteOffset + programBytes.byteLength,
                    ),
                    memory: childMemory,
                    channelOffset: childChannelOffset,
                };

                const childWorker = workerAdapter.createWorker(childInitData);
                setupChildWorkerHandlers(childWorker, childPid);

                return [childChannelOffset];
            },

            onExec: async (_pid, path) => {
                const resolved = resolveProgram(path);
                if (!resolved) return -2; // ENOENT
                return -38; // ENOSYS for now
            },

            onExit: (pid, exitStatus) => {
                const entry = processExits.get(pid);
                if (entry) {
                    entry.resolve(exitStatus);
                }
                kernelWorker.unregisterProcess(pid);
            },
        },
    );

    // Initialize kernel
    await kernelWorker.init(
        kernelBytes.buffer.slice(
            kernelBytes.byteOffset,
            kernelBytes.byteOffset + kernelBytes.byteLength,
        ),
    );

    // Create shared memory for the process
    const MAX_PAGES = 16384;
    const memory = new WebAssembly.Memory({
        initial: 17,
        maximum: MAX_PAGES,
        shared: true,
    });

    // Place channel at the LAST 2 pages of the address space so it
    // doesn't collide with the heap (brk grows up from __heap_base)
    // or mmap (starts at 256 MB). Growing to max is instant since
    // shared memory pre-allocates the backing store.
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17); // grow to max
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    // Register process with kernel
    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setNextChildPid(2);

    // Spawn the process worker
    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid,
        ppid: 0,
        programBytes: programBytes.buffer.slice(
            programBytes.byteOffset,
            programBytes.byteOffset + programBytes.byteLength,
        ),
        memory,
        channelOffset,
        env: Object.entries(process.env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`),
        argv: [programPath, ...process.argv.slice(3)],
    };

    const worker = workerAdapter.createWorker(initData);

    // Register main process in processExits so onExit callback can resolve it
    const exitPromise = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Process timed out"));
        }, 30_000);

        processExits.set(pid, {
            resolve: (status: number) => {
                clearTimeout(timeout);
                resolve(status);
            },
        });

        worker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                clearTimeout(timeout);
                kernelWorker.unregisterProcess(pid);
                resolve(m.status);
            } else if (m.type === "error") {
                clearTimeout(timeout);
                kernelWorker.unregisterProcess(pid);
                reject(new Error(m.message));
            }
        });

        worker.on("error", (err: Error) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    const status = await exitPromise;
    await worker.terminate().catch(() => {});
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
