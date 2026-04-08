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
import type { CentralizedWorkerInitMessage, CentralizedThreadInitMessage, WorkerToHostMessage } from "../host/src/worker-protocol";
import { ThreadPageAllocator } from "../host/src/thread-allocator";

const CH_TOTAL_SIZE = 40 + 65536; // header (40B) + data buffer (64KB)

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const workerAdapter = new NodeWorkerAdapter();

// Built-in program resolution
const coreutilsWasm = resolve(repoRoot, "examples/libs/coreutils/bin/coreutils.wasm");
const dashBuilt = resolve(repoRoot, "examples/libs/dash/bin/dash.wasm");
const dashWasm = existsSync(dashBuilt) ? dashBuilt : resolve(repoRoot, "host/wasm/sh.wasm");
const grepWasm = resolve(repoRoot, "examples/libs/grep/bin/grep.wasm");
const sedWasm = resolve(repoRoot, "examples/libs/sed/bin/sed.wasm");

// GNU coreutils multi-call binary supports all of these as argv[0]
const coreutilsNames = [
    "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
    "head", "tail", "wc", "sort", "uniq", "tr", "cut", "paste", "tee",
    "true", "false", "yes", "env", "printenv", "printf", "expr", "test", "[",
    "basename", "dirname", "readlink", "realpath", "stat", "touch", "date",
    "sleep", "id", "whoami", "uname", "hostname", "pwd", "dd", "od", "md5sum",
    "sha256sum", "base64", "seq", "factor", "nproc", "du", "df",
];

const builtinPrograms: Record<string, string> = {
    "echo": resolve(repoRoot, "examples/echo.wasm"),
    "/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "/usr/bin/echo": resolve(repoRoot, "examples/echo.wasm"),
    "sh": dashWasm,
    "/bin/sh": dashWasm,
    "dash": dashWasm,
    "/bin/dash": dashWasm,
    "grep": grepWasm,
    "/bin/grep": grepWasm,
    "/usr/bin/grep": grepWasm,
    "sed": sedWasm,
    "/bin/sed": sedWasm,
    "/usr/bin/sed": sedWasm,
    "gencat": resolve(repoRoot, "examples/gencat.wasm"),
    "/usr/bin/gencat": resolve(repoRoot, "examples/gencat.wasm"),
};

// Add coreutils mappings for all known tool names
for (const name of coreutilsNames) {
    builtinPrograms[name] = coreutilsWasm;
    builtinPrograms[`/bin/${name}`] = coreutilsWasm;
    builtinPrograms[`/usr/bin/${name}`] = coreutilsWasm;
}

function resolveProgram(path: string): ArrayBuffer | null {
    const mapped = builtinPrograms[path];
    if (mapped && existsSync(mapped)) {
        const bytes = readFileSync(mapped);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const kernelCwd = process.env.KERNEL_CWD || process.cwd();
    const candidates = [
        path,
        path.endsWith(".wasm") ? path : `${path}.wasm`,
        resolve(repoRoot, `examples/${path}.wasm`),
        // Resolve relative to kernel CWD (sortix tests exec themselves by relative path)
        resolve(kernelCwd, path),
        resolve(kernelCwd, path.endsWith(".wasm") ? path : `${path}.wasm`),
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

    // Track process exits and workers per-pid
    const processExits = new Map<number, { resolve: (status: number) => void }>();
    const workers = new Map<number, WorkerHandle>();
    const processProgramBytes = new Map<number, ArrayBuffer>();

    function setupChildWorkerHandlers(worker: WorkerHandle, pid: number) {
        worker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "exit") {
                const entry = processExits.get(m.pid);
                if (entry) {
                    entry.resolve(m.status);
                }
                kernelWorker.unregisterProcess(m.pid);
                workers.delete(m.pid);
                processProgramBytes.delete(m.pid);
                worker.terminate().catch(() => {});
            }
        });
        worker.on("error", () => {
            const entry = processExits.get(pid);
            if (entry) {
                entry.resolve(1);
            }
            kernelWorker.unregisterProcess(pid);
            workers.delete(pid);
            processProgramBytes.delete(pid);
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

                // Spawn child worker with asyncify fork support
                const ASYNCIFY_BUF_SIZE = 16384;
                const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
                // Use per-pid program bytes if available (fork-after-exec), else initial program
                const parentProgram = processProgramBytes.get(parentPid) ??
                    programBytes.buffer.slice(programBytes.byteOffset, programBytes.byteOffset + programBytes.byteLength);

                const childInitData: CentralizedWorkerInitMessage = {
                    type: "centralized_init",
                    pid: childPid,
                    ppid: parentPid,
                    programBytes: parentProgram,
                    memory: childMemory,
                    channelOffset: childChannelOffset,
                    isForkChild: true,
                    asyncifyBufAddr,
                };

                const childWorker = workerAdapter.createWorker(childInitData);
                workers.set(childPid, childWorker);
                processProgramBytes.set(childPid, parentProgram);
                setupChildWorkerHandlers(childWorker, childPid);

                return [childChannelOffset];
            },

            onExec: async (pid, path, argv, envp) => {
                const resolved = resolveProgram(path);
                if (!resolved) return -2; // ENOENT — process stays alive for retry

                // Program found — run kernel exec setup (close CLOEXEC, reset signals)
                const setupResult = kernelWorker.kernelExecSetup(pid);
                if (setupResult < 0) return setupResult;

                // Prepare process for replacement
                kernelWorker.prepareProcessForExec(pid);

                // Terminate old worker
                const oldWorker = workers.get(pid);
                if (oldWorker) {
                    await oldWorker.terminate().catch(() => {});
                    workers.delete(pid);
                }

                // Create fresh memory for the new program
                const newMemory = new WebAssembly.Memory({
                    initial: 17,
                    maximum: MAX_PAGES,
                    shared: true,
                });
                const newChannelOffset = (MAX_PAGES - 2) * 65536;
                newMemory.grow(MAX_PAGES - 17);
                new Uint8Array(newMemory.buffer, newChannelOffset, CH_TOTAL_SIZE).fill(0);

                // Register new process with same pid
                kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], { skipKernelCreate: true });

                // Track new program bytes for this pid (for fork-after-exec)
                processProgramBytes.set(pid, resolved);

                // Spawn new worker
                const execInitData: CentralizedWorkerInitMessage = {
                    type: "centralized_init",
                    pid,
                    ppid: 0,
                    programBytes: resolved,
                    memory: newMemory,
                    channelOffset: newChannelOffset,
                    argv,
                    env: envp,
                };

                const newWorker = workerAdapter.createWorker(execInitData);
                workers.set(pid, newWorker);
                setupChildWorkerHandlers(newWorker, pid);

                return 0;
            },

            onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
                const alloc = threadAllocator.allocate(memory);

                // Register thread channel with kernel worker
                kernelWorker.addChannel(pid, alloc.channelOffset, tid);

                // Spawn thread worker
                // Use per-pid program bytes if available (thread after exec), else initial program
                const threadProgram = processProgramBytes.get(pid) ??
                    programBytes.buffer.slice(programBytes.byteOffset, programBytes.byteOffset + programBytes.byteLength);

                const threadInitData: CentralizedThreadInitMessage = {
                    type: "centralized_thread_init",
                    pid,
                    tid,
                    programBytes: threadProgram,
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
                        threadAllocator.free(alloc.basePage);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", (err: Error) => {
                    console.error(`[thread worker error] ${err.message}`);
                    kernelWorker.notifyThreadExit(pid, tid);
                    kernelWorker.removeChannel(pid, alloc.channelOffset);
                    threadAllocator.free(alloc.basePage);
                });
                threadWorker.on("exit", (code: number) => {
                    console.error(`[thread worker exit] code=${code}`);
                });

                return tid;
            },

            onExit: (exitPid, exitStatus) => {
                const entry = processExits.get(exitPid);
                if (entry) {
                    entry.resolve(exitStatus);
                }
                if (exitPid === pid) {
                    kernelWorker.unregisterProcess(exitPid);
                } else {
                    // Child: deactivate channels but keep in kernel process table
                    // as zombie until reaped by wait/waitpid
                    kernelWorker.deactivateProcess(exitPid);
                }
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
    const threadAllocator = new ThreadPageAllocator(MAX_PAGES);
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
    const pid = 100;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, process.env.KERNEL_CWD || process.cwd());
    kernelWorker.setNextChildPid(101);

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
