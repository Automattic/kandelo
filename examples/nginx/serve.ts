/**
 * serve.ts — Run nginx.wasm serving static files on the kernel.
 *
 * Starts nginx with master_process on and 2 worker processes.
 * The master (pid 1) forks 2 workers that handle connections.
 *
 * Uses CentralizedKernelWorker which automatically bridges real TCP
 * connections into the kernel's pipe-backed sockets when nginx calls
 * listen().
 *
 * Usage:
 *   npx tsx examples/nginx/serve.ts
 *
 * Then: curl http://localhost:8080/
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import type { CentralizedWorkerInitMessage, WorkerToHostMessage } from "../../host/src/worker-protocol";

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

// Set up filesystem layout for nginx
// nginx expects: prefix/conf/nginx.conf, prefix/html/*, prefix/logs/, etc.
const prefix = resolve(scriptDir);
const tmpDir = "/tmp/nginx-wasm";

// Create temp directories nginx needs
for (const dir of ["client_body_temp", "proxy_temp", "fastcgi_temp"]) {
    mkdirSync(join(tmpDir, dir), { recursive: true });
}
mkdirSync(join(tmpDir, "logs"), { recursive: true });

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const nginxWasm = resolve(scriptDir, "nginx.wasm");
    if (!existsSync(nginxWasm)) {
        console.error("nginx.wasm not found. Run: bash examples/nginx/build.sh");
        process.exit(1);
    }

    const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
    const nginxBytes = loadBytes(nginxWasm);

    const io = new NodePlatformIO();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const kernelWorker = new CentralizedKernelWorker(
        { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true },
        io,
        {
            onFork: async (parentPid, childPid, parentMemory) => {
                console.log(`[kernel] fork: pid ${parentPid} → ${childPid}`);
                const parentBuf = new Uint8Array(parentMemory.buffer);
                const parentPages = Math.ceil(parentBuf.byteLength / 65536);
                const childMemory = new WebAssembly.Memory({
                    initial: parentPages,
                    maximum: MAX_PAGES,
                    shared: true,
                });
                if (parentPages < MAX_PAGES) {
                    childMemory.grow(MAX_PAGES - parentPages);
                }
                new Uint8Array(childMemory.buffer).set(parentBuf);

                const childChannelOffset = (MAX_PAGES - 2) * 65536;
                new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

                kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

                const ASYNCIFY_BUF_SIZE = 16384;
                const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
                const childInitData: CentralizedWorkerInitMessage = {
                    type: "centralized_init",
                    pid: childPid,
                    ppid: parentPid,
                    programBytes: nginxBytes,
                    memory: childMemory,
                    channelOffset: childChannelOffset,
                    isForkChild: true,
                    asyncifyBufAddr,
                };

                const childWorker = workerAdapter.createWorker(childInitData);
                workers.set(childPid, childWorker);
                childWorker.on("error", () => {
                    kernelWorker.unregisterProcess(childPid);
                    workers.delete(childPid);
                });

                return [childChannelOffset];
            },

            onExec: async () => -38, // ENOSYS

            onExit: (pid, exitStatus) => {
                console.log(`[kernel] process ${pid} exited with status ${exitStatus}`);
                if (pid === 1) {
                    kernelWorker.unregisterProcess(pid);
                } else {
                    kernelWorker.deactivateProcess(pid);
                }
                workers.delete(pid);
            },
        },
    );

    // Initialize kernel
    await kernelWorker.init(kernelBytes);

    // Create shared memory for the master process
    const memory = new WebAssembly.Memory({
        initial: 17,
        maximum: MAX_PAGES,
        shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    // Register master process with kernel
    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, prefix);
    kernelWorker.setNextChildPid(2);

    // Spawn the nginx master process
    const confPath = resolve(scriptDir, "nginx.conf");
    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid,
        ppid: 0,
        programBytes: nginxBytes,
        memory,
        channelOffset,
        env: [
            `HOME=/tmp`,
            `PATH=/usr/local/bin:/usr/bin:/bin`,
        ],
        argv: [
            "nginx",
            "-p", prefix + "/",
            "-c", confPath,
        ],
    };

    console.log(`Starting nginx multi-worker (prefix=${prefix})...`);
    console.log("  master (pid 1) + 2 worker processes");
    console.log("Listening on http://localhost:8080/");
    console.log("Press Ctrl+C to stop.");

    const masterWorker = workerAdapter.createWorker(initData);
    workers.set(pid, masterWorker);

    const exitPromise = new Promise<number>((resolve, reject) => {
        masterWorker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                kernelWorker.unregisterProcess(pid);
                resolve(m.status);
            } else if (m.type === "error") {
                kernelWorker.unregisterProcess(pid);
                reject(new Error(m.message));
            }
        });

        masterWorker.on("error", (err: Error) => {
            reject(err);
        });
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
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
