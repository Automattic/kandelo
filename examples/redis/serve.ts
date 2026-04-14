/**
 * serve.ts — Run redis-server.wasm on the wasm-posix-kernel.
 *
 * Starts Redis 7.2 with 3 background threads (close_file, aof_fsync, lazy_free).
 * The kernel automatically bridges real TCP connections into the
 * kernel's pipe-backed sockets when redis calls listen().
 *
 * Usage:
 *   npx tsx examples/redis/serve.ts [port]
 *
 * Then: redis-cli -p 6379 SET hello world
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import { patchWasmForThread } from "../../host/src/worker-main";
import type {
    CentralizedWorkerInitMessage,
    CentralizedThreadInitMessage,
    WorkerToHostMessage,
} from "../../host/src/worker-protocol";
import { ThreadPageAllocator } from "../../host/src/thread-allocator";

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const port = process.argv[2] || "6379";

    const redisWasm = resolve(scriptDir, "../libs/redis/bin/redis-server.wasm");
    if (!existsSync(redisWasm)) {
        console.error("redis-server.wasm not found. Run: bash examples/libs/redis/build-redis.sh");
        process.exit(1);
    }

    const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
    const redisBytes = loadBytes(redisWasm);

    // Pre-compile thread module (strip start + neuter ctors) so threads start instantly.
    console.log("Pre-compiling thread module...");
    const threadPatchedBytes = patchWasmForThread(redisBytes);
    const threadModule = new WebAssembly.Module(threadPatchedBytes);
    console.log("Thread module ready.");

    // Create data directory for Redis persistence
    const dataDir = resolve(scriptDir, "data");
    mkdirSync(dataDir, { recursive: true });

    const io = new NodePlatformIO();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

    const kernelWorker = new CentralizedKernelWorker(
        { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true },
        io,
        {
            onFork: async () => {
                console.error("[kernel] unexpected fork");
                return [];
            },

            onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
                const alloc = threadAllocator.allocate(memory);

                console.log(`[kernel] clone: pid=${pid} tid=${tid} fn=${fnPtr} channelOff=${alloc.channelOffset}`);

                kernelWorker.addChannel(pid, alloc.channelOffset, tid);

                const threadInitData: CentralizedThreadInitMessage = {
                    type: "centralized_thread_init",
                    pid,
                    tid,
                    programBytes: redisBytes,
                    programModule: threadModule,
                    memory,
                    channelOffset: alloc.channelOffset,
                    fnPtr,
                    argPtr,
                    stackPtr,
                    tlsPtr,
                    ctidPtr,
                    tlsAllocAddr: alloc.tlsAllocAddr,
                };

                const threadWorker = workerAdapter.createWorker(threadInitData);
                threadWorker.on("message", (msg: unknown) => {
                    const m = msg as WorkerToHostMessage;
                    if (m.type === "thread_exit") {
                        console.log(`[kernel] thread ${tid} exited`);
                        kernelWorker.notifyThreadExit(pid, tid);
                        kernelWorker.removeChannel(pid, alloc.channelOffset);
                        threadAllocator.free(alloc.basePage);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", (err: Error) => {
                    console.error(`[kernel] thread ${tid} error: ${err.message}`);
                    kernelWorker.notifyThreadExit(pid, tid);
                    kernelWorker.removeChannel(pid, alloc.channelOffset);
                    threadAllocator.free(alloc.basePage);
                });

                return tid;
            },

            onExec: async () => -38, // ENOSYS

            onExit: (pid, exitStatus) => {
                console.log(`[kernel] process ${pid} exited with status ${exitStatus}`);
                kernelWorker.unregisterProcess(pid);
                workers.delete(pid);
            },
        },
    );

    // Initialize kernel
    await kernelWorker.init(kernelBytes);

    // Create shared memory for the redis process
    const memory = new WebAssembly.Memory({
        initial: 17,
        maximum: MAX_PAGES,
        shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    // Register process with kernel
    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, dataDir);
    kernelWorker.setNextChildPid(2);

    // Start redis-server
    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid,
        ppid: 0,
        programBytes: redisBytes,
        memory,
        channelOffset,
        env: [
            `HOME=/tmp`,
            `PATH=/usr/local/bin:/usr/bin:/bin`,
        ],
        argv: [
            "redis-server",
            "--port", port,
            "--bind", "0.0.0.0",
            "--dir", dataDir,
            "--save", "",         // Disable RDB snapshots
            "--appendonly", "no", // Disable AOF
            "--loglevel", "notice",
            "--daemonize", "no",
            "--databases", "16",
            "--io-threads", "1",  // Single I/O thread
        ],
    };

    console.log(`Starting Redis 7.2 on port ${port}...`);
    console.log(`Data directory: ${dataDir}`);
    console.log(`  redis-cli -p ${port} SET hello world`);
    console.log(`  redis-cli -p ${port} GET hello`);
    console.log("Press Ctrl+C to stop.\n");

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);

    const exitPromise = new Promise<number>((resolveP, reject) => {
        worker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                kernelWorker.unregisterProcess(pid);
                resolveP(m.status);
            } else if (m.type === "error") {
                console.error("Last syscalls:\n" + kernelWorker.dumpLastSyscalls(pid));
                kernelWorker.unregisterProcess(pid);
                reject(new Error(m.message));
            }
        });

        worker.on("error", (err: Error) => {
            reject(err);
        });
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
        console.log("\nShutting down Redis...");
        for (const [, w] of workers) {
            await w.terminate().catch(() => {});
        }
        process.exit(0);
    });

    const status = await exitPromise;
    for (const [, w] of workers) {
        await w.terminate().catch(() => {});
    }
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
