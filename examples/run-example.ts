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
const gitWasm = resolve(repoRoot, "examples/libs/git/bin/git.wasm");
const bcWasm = resolve(repoRoot, "examples/libs/bc/bin/bc.wasm");
const fileWasm = resolve(repoRoot, "examples/libs/file/bin/file.wasm");
const lessWasm = resolve(repoRoot, "examples/libs/less/bin/less.wasm");
const m4Wasm = resolve(repoRoot, "examples/libs/m4/bin/m4.wasm");
const makeWasm = resolve(repoRoot, "examples/libs/make/bin/make.wasm");
const tarWasm = resolve(repoRoot, "examples/libs/tar/bin/tar.wasm");
const curlWasm = resolve(repoRoot, "examples/libs/curl/bin/curl.wasm");
const wgetWasm = resolve(repoRoot, "examples/libs/wget/bin/wget.wasm");
const gzipWasm = resolve(repoRoot, "examples/libs/gzip/bin/gzip.wasm");
const bzip2Wasm = resolve(repoRoot, "examples/libs/bzip2/bin/bzip2.wasm");
const xzWasm = resolve(repoRoot, "examples/libs/xz/bin/xz.wasm");
const zstdWasm = resolve(repoRoot, "examples/libs/zstd/bin/zstd.wasm");
const zipWasm = resolve(repoRoot, "examples/libs/zip/bin/zip.wasm");
const unzipWasm = resolve(repoRoot, "examples/libs/unzip/bin/unzip.wasm");
const lsofWasm = resolve(repoRoot, "examples/lsof.wasm");
const rubyWasm = resolve(repoRoot, "examples/libs/ruby/bin/ruby.wasm");
const vimWasm = resolve(repoRoot, "examples/libs/vim/bin/vim.wasm");
const gawkWasm = resolve(repoRoot, "examples/libs/gawk/bin/gawk.wasm");
const findWasm = resolve(repoRoot, "examples/libs/findutils/bin/find.wasm");
const xargsWasm = resolve(repoRoot, "examples/libs/findutils/bin/xargs.wasm");
const diffWasm = resolve(repoRoot, "examples/libs/diffutils/bin/diff.wasm");
const cmpWasm = resolve(repoRoot, "examples/libs/diffutils/bin/cmp.wasm");
const sdiffWasm = resolve(repoRoot, "examples/libs/diffutils/bin/sdiff.wasm");
const diff3Wasm = resolve(repoRoot, "examples/libs/diffutils/bin/diff3.wasm");

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
    "egrep": grepWasm,
    "/bin/egrep": grepWasm,
    "/usr/bin/egrep": grepWasm,
    "fgrep": grepWasm,
    "/bin/fgrep": grepWasm,
    "/usr/bin/fgrep": grepWasm,
    "sed": sedWasm,
    "/bin/sed": sedWasm,
    "/usr/bin/sed": sedWasm,
    "gencat": resolve(repoRoot, "examples/gencat.wasm"),
    "/usr/bin/gencat": resolve(repoRoot, "examples/gencat.wasm"),
    "git": gitWasm,
    "/usr/bin/git": gitWasm,
    "/bin/git": gitWasm,
    "bc": bcWasm,
    "/usr/bin/bc": bcWasm,
    "/bin/bc": bcWasm,
    "file": fileWasm,
    "/usr/bin/file": fileWasm,
    "/bin/file": fileWasm,
    "less": lessWasm,
    "/usr/bin/less": lessWasm,
    "/bin/less": lessWasm,
    "m4": m4Wasm,
    "/usr/bin/m4": m4Wasm,
    "/bin/m4": m4Wasm,
    "make": makeWasm,
    "/usr/bin/make": makeWasm,
    "/bin/make": makeWasm,
    "tar": tarWasm,
    "/usr/bin/tar": tarWasm,
    "/bin/tar": tarWasm,
    "curl": curlWasm,
    "/usr/bin/curl": curlWasm,
    "/bin/curl": curlWasm,
    "wget": wgetWasm,
    "/usr/bin/wget": wgetWasm,
    "/bin/wget": wgetWasm,
    "gzip": gzipWasm,
    "/usr/bin/gzip": gzipWasm,
    "/bin/gzip": gzipWasm,
    "gunzip": gzipWasm,
    "/usr/bin/gunzip": gzipWasm,
    "/bin/gunzip": gzipWasm,
    "zcat": gzipWasm,
    "/usr/bin/zcat": gzipWasm,
    "/bin/zcat": gzipWasm,
    "bzip2": bzip2Wasm,
    "/usr/bin/bzip2": bzip2Wasm,
    "/bin/bzip2": bzip2Wasm,
    "bunzip2": bzip2Wasm,
    "/usr/bin/bunzip2": bzip2Wasm,
    "/bin/bunzip2": bzip2Wasm,
    "bzcat": bzip2Wasm,
    "/usr/bin/bzcat": bzip2Wasm,
    "/bin/bzcat": bzip2Wasm,
    "xz": xzWasm,
    "/usr/bin/xz": xzWasm,
    "/bin/xz": xzWasm,
    "unxz": xzWasm,
    "/usr/bin/unxz": xzWasm,
    "/bin/unxz": xzWasm,
    "xzcat": xzWasm,
    "/usr/bin/xzcat": xzWasm,
    "/bin/xzcat": xzWasm,
    "lzma": xzWasm,
    "/usr/bin/lzma": xzWasm,
    "/bin/lzma": xzWasm,
    "unlzma": xzWasm,
    "/usr/bin/unlzma": xzWasm,
    "/bin/unlzma": xzWasm,
    "lzcat": xzWasm,
    "/usr/bin/lzcat": xzWasm,
    "/bin/lzcat": xzWasm,
    "zstd": zstdWasm,
    "/usr/bin/zstd": zstdWasm,
    "/bin/zstd": zstdWasm,
    "unzstd": zstdWasm,
    "/usr/bin/unzstd": zstdWasm,
    "/bin/unzstd": zstdWasm,
    "zstdcat": zstdWasm,
    "/usr/bin/zstdcat": zstdWasm,
    "/bin/zstdcat": zstdWasm,
    "zip": zipWasm,
    "/usr/bin/zip": zipWasm,
    "/bin/zip": zipWasm,
    "unzip": unzipWasm,
    "/usr/bin/unzip": unzipWasm,
    "/bin/unzip": unzipWasm,
    "zipinfo": unzipWasm,
    "/usr/bin/zipinfo": unzipWasm,
    "/bin/zipinfo": unzipWasm,
    "funzip": unzipWasm,
    "/usr/bin/funzip": unzipWasm,
    "/bin/funzip": unzipWasm,
    "lsof": lsofWasm,
    "/usr/bin/lsof": lsofWasm,
    "/bin/lsof": lsofWasm,
    "ruby": rubyWasm,
    "/usr/bin/ruby": rubyWasm,
    "/bin/ruby": rubyWasm,
    "vim": vimWasm,
    "/usr/bin/vim": vimWasm,
    "/bin/vim": vimWasm,
    "vi": vimWasm,
    "/usr/bin/vi": vimWasm,
    "/bin/vi": vimWasm,
    "gawk": gawkWasm,
    "/bin/gawk": gawkWasm,
    "/usr/bin/gawk": gawkWasm,
    "awk": gawkWasm,
    "/bin/awk": gawkWasm,
    "/usr/bin/awk": gawkWasm,
    "find": findWasm,
    "/bin/find": findWasm,
    "/usr/bin/find": findWasm,
    "xargs": xargsWasm,
    "/bin/xargs": xargsWasm,
    "/usr/bin/xargs": xargsWasm,
    "diff": diffWasm,
    "/bin/diff": diffWasm,
    "/usr/bin/diff": diffWasm,
    "cmp": cmpWasm,
    "/bin/cmp": cmpWasm,
    "/usr/bin/cmp": cmpWasm,
    "sdiff": sdiffWasm,
    "/bin/sdiff": sdiffWasm,
    "/usr/bin/sdiff": sdiffWasm,
    "diff3": diff3Wasm,
    "/bin/diff3": diff3Wasm,
    "/usr/bin/diff3": diff3Wasm,
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
    let programPath: string;
    if (name.endsWith(".wasm")) {
        programPath = resolve(name);
    } else if (builtinPrograms[name] && existsSync(builtinPrograms[name])) {
        programPath = builtinPrograms[name];
    } else {
        programPath = resolve(`examples/${name}.wasm`);
    }

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
    const processArgv = [programPath, ...process.argv.slice(3)];
    kernelWorker.registerProcess(pid, memory, [channelOffset], { argv: processArgv });
    kernelWorker.setCwd(pid, process.env.KERNEL_CWD || process.cwd());
    kernelWorker.setNextChildPid(101);

    // Git system config via environment (Node.js VFS is the host filesystem,
    // so we can't write /etc/gitconfig; use GIT_CONFIG_COUNT instead).
    const gitConfigEntries: [string, string][] = [
        ["gc.auto", "0"],
        ["maintenance.auto", "false"],
        ["core.pager", "cat"],
        ["user.name", "User"],
        ["user.email", "user@wasm.local"],
        ["init.defaultBranch", "main"],
    ];
    const gitEnv: string[] = [
        "GIT_CONFIG_NOSYSTEM=1",
        `GIT_CONFIG_COUNT=${gitConfigEntries.length}`,
        ...gitConfigEntries.flatMap(([key, val], i) => [
            `GIT_CONFIG_KEY_${i}=${key}`,
            `GIT_CONFIG_VALUE_${i}=${val}`,
        ]),
    ];

    // When stdin is not a terminal (piped or redirected), set it as finite
    // so reads return EOF instead of blocking forever.
    if (!process.stdin.isTTY) {
        kernelWorker.setStdinData(pid, new Uint8Array(0));
    }

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
        env: [
            ...Object.entries(process.env)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k}=${v}`),
            ...gitEnv,
        ],
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
