/**
 * serve.ts — Run MariaDB 10.5 (mysqld) on the wasm-posix-kernel.
 *
 * Starts mysqld in single-thread mode with Aria storage engine.
 * The kernel's PlatformIO layer provides access to the host filesystem
 * for data directory and temp files.
 *
 * Usage:
 *   npx tsx examples/mariadb/serve.ts
 *
 * Then: mysql -h 127.0.0.1 -P 3306 -u root
 */

import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
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

const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");
const installDir = resolve(mariadbLibDir, "mariadb-install");

// Create data directory on host
const dataDir = resolve(scriptDir, "data");
mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
mkdirSync(resolve(dataDir, "tmp"), { recursive: true });

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    const mysqldWasm = resolve(installDir, "bin/mariadbd");
    if (!existsSync(mysqldWasm)) {
        console.error("mariadbd not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
        process.exit(1);
    }

    const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
    const mysqldBytes = loadBytes(mysqldWasm);

    // Pre-compile thread module (strip start + neuter ctors) so threads start instantly.
    // Without this, each thread compiles 13MB wasm, causing the main thread to spin-wait.
    console.log("Pre-compiling thread module...");
    const threadPatchedBytes = patchWasmForThread(mysqldBytes);
    const threadModule = new WebAssembly.Module(threadPatchedBytes);
    console.log("Thread module ready.");

    const io = new NodePlatformIO();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    // Thread channel allocation: count down from main channel
    // Main channel is at (MAX_PAGES - 2) * 65536
    // Each thread needs 4 pages: 2 for channel (65576 bytes spills past 1 page)
    // + 1 gap page + 1 for TLS
    let nextThreadChannelPage = MAX_PAGES - 4;

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
                    programBytes: mysqldBytes,
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

            onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
                const threadChannelOffset = nextThreadChannelPage * 65536;
                const tlsAllocAddr = (nextThreadChannelPage - 2) * 65536;
                nextThreadChannelPage -= 4;

                console.log(`[kernel] clone: pid=${pid} tid=${tid} fn=${fnPtr} channelOff=${threadChannelOffset} tlsAddr=${tlsAllocAddr}`);

                new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
                new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);

                kernelWorker.addChannel(pid, threadChannelOffset, tid);

                const threadInitData: CentralizedThreadInitMessage = {
                    type: "centralized_thread_init",
                    pid,
                    tid,
                    programBytes: mysqldBytes,
                    programModule: threadModule,
                    memory,
                    channelOffset: threadChannelOffset,
                    fnPtr,
                    argPtr,
                    stackPtr,
                    tlsPtr,
                    ctidPtr,
                    tlsAllocAddr,
                };

                const threadWorker = workerAdapter.createWorker(threadInitData);
                threadWorker.on("message", (msg: unknown) => {
                    const m = msg as WorkerToHostMessage;
                    if (m.type === "thread_exit") {
                        console.error(`[kernel] thread ${tid} exited`);
                        kernelWorker.notifyThreadExit(pid, tid);
                        kernelWorker.removeChannel(pid, threadChannelOffset);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", (err: Error) => {
                    console.error(`[kernel] thread ${tid} error: ${err.message}`);
                    kernelWorker.notifyThreadExit(pid, tid);
                    kernelWorker.removeChannel(pid, threadChannelOffset);
                });
                threadWorker.on("exit", (code: number) => {
                    console.error(`[kernel] thread ${tid} worker EXIT code=${code}`);
                });

                return tid;
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

    await kernelWorker.init(kernelBytes);

    const memory = new WebAssembly.Memory({
        initial: 17,
        maximum: MAX_PAGES,
        shared: true,
    });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, dataDir);
    kernelWorker.setNextChildPid(2);

    // Check if data directory needs bootstrapping
    const mysqlDir = resolve(dataDir, "mysql");
    const needsBootstrap = readdirSync(mysqlDir).length === 0;

    const debugMode = process.argv.includes("--debug-help");
    const bootstrapMode = needsBootstrap || process.argv.includes("--bootstrap");

    const commonArgs = [
        "mariadbd",
        "--no-defaults",
        `--datadir=${dataDir}`,
        `--tmpdir=${resolve(dataDir, "tmp")}`,
        "--default-storage-engine=Aria",
        "--skip-grant-tables",
        "--key-buffer-size=1048576",
        "--table-open-cache=10",
        "--sort-buffer-size=262144",
    ];

    const serverArgs = debugMode ? [
        "mariadbd",
        "--no-defaults",
        "--help",
        "--verbose",
    ] : bootstrapMode ? [
        ...commonArgs,
        "--bootstrap",
        "--log-warnings=0",
    ] : [
        ...commonArgs,
        "--thread-handling=no-threads",
        "--skip-networking=0",
        "--port=3306",
        "--bind-address=0.0.0.0",
        "--socket=",
        "--max-connections=10",
    ];

    // For bootstrap mode, prepare SQL data for stdin
    if (bootstrapMode) {
        console.log("Bootstrapping MariaDB system tables...");
        const shareDir = resolve(installDir, "share/mysql");
        const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
        const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
        const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
        kernelWorker.setStdinData(pid, new TextEncoder().encode(bootstrapSql));
    } else {
        console.log("Starting MariaDB 10.5 on wasm-posix-kernel...");
        console.log(`Data directory: ${dataDir}`);
        console.log("Connect with: mysql -h 127.0.0.1 -P 3306 -u root");
    }
    console.log("");

    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid,
        ppid: 0,
        programBytes: mysqldBytes,
        memory,
        channelOffset,
        env: [
            "HOME=/tmp",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "TMPDIR=/tmp",
        ],
        argv: serverArgs,
    };

    const masterWorker = workerAdapter.createWorker(initData);
    workers.set(pid, masterWorker);



    const exitPromise = new Promise<number>((resolveP, reject) => {
        masterWorker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                kernelWorker.unregisterProcess(pid);
                resolveP(m.status);
            } else if (m.type === "error") {
                console.error("Last syscalls before crash:\n" + kernelWorker.dumpLastSyscalls(pid));
                console.error("Full error message:\n" + m.message);
                kernelWorker.unregisterProcess(pid);
                reject(new Error(m.message));
            }
        });

        masterWorker.on("error", (err: Error) => {
            reject(err);
        });
    });

    process.on("SIGINT", async () => {
        console.log("\nShutting down...");
        for (const [, w] of workers) {
            await w.terminate().catch(() => {});
        }
        process.exit(0);
    });

    let status: number;
    if (bootstrapMode) {
        // Bootstrap mode: after stdin is consumed, mysqld should exit.
        // Background threads may hang during shutdown — race with a timeout.
        const timeoutPromise = new Promise<number>((resolveP) => {
            setTimeout(() => {
                console.log("\nBootstrap appears complete (timeout). Forcing shutdown.");
                resolveP(0);
            }, 30000);
        });
        status = await Promise.race([exitPromise, timeoutPromise]);
    } else {
        status = await exitPromise;
    }
    for (const [, w] of workers) {
        await w.terminate().catch(() => {});
    }

    if (bootstrapMode && status === 0 && !process.argv.includes("--bootstrap")) {
        console.log("\nBootstrap complete! Restart to run the server.\n");
    }
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
