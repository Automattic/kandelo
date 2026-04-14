/**
 * serve.ts — Run Erlang/OTP BEAM VM on the wasm-posix-kernel.
 *
 * Starts the BEAM emulator with single scheduler (+S 1:1) and
 * threading support for dirty schedulers and async threads.
 *
 * Usage:
 *   npx tsx examples/erlang/serve.ts -eval "io:format(\"Hello from BEAM!~n\"), halt()."
 *   npx tsx examples/erlang/serve.ts -eval "ring:start()."
 */

import { readFileSync, existsSync, writeFileSync, appendFileSync } from "fs";
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

const erlangLibDir = resolve(repoRoot, "examples/libs/erlang");
const installDir = resolve(erlangLibDir, "erlang-install");
const beamWasm = resolve(erlangLibDir, "bin/beam.wasm");

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
    if (!existsSync(beamWasm)) {
        console.error("beam.wasm not found. Run: bash examples/libs/erlang/build-erlang.sh");
        process.exit(1);
    }

    const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
    const beamBytes = loadBytes(beamWasm);

    // Pre-compile thread module for thread workers
    console.log("Pre-compiling thread module...");
    const threadPatchedBytes = patchWasmForThread(beamBytes);
    const threadModule = new WebAssembly.Module(threadPatchedBytes);
    console.log("Thread module ready.");

    const io = new NodePlatformIO();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
    const threadWorkers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

    const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

    const kernelWorker = new CentralizedKernelWorker(
        { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true, enableSyscallLog: false },
        io,
        {
            onFork: async (parentPid, childPid, parentMemory) => {
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
                    programBytes: beamBytes,
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
                console.error(`[onClone] pid=${pid} tid=${tid} fnPtr=${fnPtr} argPtr=${argPtr}`);
                const alloc = threadAllocator.allocate(memory);

                // TLS is now stored inside the channel spill page, not the separate TLS page.
                const CH_TOTAL = 65608; // CH_HEADER_SIZE (72) + CH_DATA_SIZE (65536)
                const safeTlsAddr = alloc.channelOffset + CH_TOTAL;

                kernelWorker.addChannel(pid, alloc.channelOffset, tid);

                const threadInitData: CentralizedThreadInitMessage = {
                    type: "centralized_thread_init",
                    pid,
                    tid,
                    programBytes: beamBytes,
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
                threadWorkers.set(tid, threadWorker);
                threadWorker.on("message", (msg: unknown) => {
                    const m = msg as any;
                    if (m.type === "debug") {
                        console.error(`[thread ${tid}] ${m.message}`);
                        return;
                    }
                    if (m.type === "thread_exit") {
                        kernelWorker.notifyThreadExit(pid, tid);
                        kernelWorker.removeChannel(pid, alloc.channelOffset);
                        threadAllocator.free(alloc.basePage);
                        threadWorkers.delete(tid);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", (err: Error) => {
                    console.error(`[kernel] thread ${tid} error: ${err.message}`);
                    kernelWorker.notifyThreadExit(pid, tid);
                    kernelWorker.removeChannel(pid, alloc.channelOffset);
                    threadAllocator.free(alloc.basePage);
                    threadWorkers.delete(tid);
                });

                return tid;
            },

            onExec: async () => -38, // ENOSYS

            onExit: (pid, exitStatus) => {
                if (pid === 1) {
                    // Terminate all thread workers before unregistering
                    for (const [tid, tw] of threadWorkers) {
                        tw.terminate().catch(() => {});
                    }
                    threadWorkers.clear();
                    kernelWorker.unregisterProcess(pid);
                } else {
                    kernelWorker.deactivateProcess(pid);
                }
                workers.delete(pid);
            },
        },
    );

    await kernelWorker.init(kernelBytes);

    const decoder = new TextDecoder();
    // Track output timing for halt detection
    let lastOutputTime = 0;
    let outputSeen = false;
    // Capture BEAM output to files for debugging (bypasses event loop issues)
    try { writeFileSync('/tmp/beam-stdout.log', ''); writeFileSync('/tmp/beam-stderr.log', ''); } catch {}
    kernelWorker.setOutputCallbacks({
        onStdout: (data) => {
            outputSeen = true;
            lastOutputTime = Date.now();
            const text = decoder.decode(data);
            process.stdout.write(text);
            try { appendFileSync('/tmp/beam-stdout.log', text); } catch {}
        },
        onStderr: (data) => {
            const text = decoder.decode(data);
            process.stderr.write(text);
            try { appendFileSync('/tmp/beam-stderr.log', text); } catch {}
        },
    });

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
    kernelWorker.setCwd(pid, scriptDir);
    kernelWorker.setNextChildPid(2);

    // Reserve top of memory for thread channels/TLS BEFORE starting the worker.
    // ThreadPageAllocator allocates 4 pages per thread top-down from (MAX_PAGES-2).
    // With 8 threads, the lowest TLS page is at MAX_PAGES - 2 - 8*4 - 2 = page 16348.
    // We must prevent the kernel's mmap from ever returning addresses in this region.
    const maxThreads = 8;
    const pagesPerThread = 4;
    const lowestThreadTlsPage = MAX_PAGES - 2 - maxThreads * pagesPerThread - 2;
    const safeMaxAddr = lowestThreadTlsPage * 65536;
    kernelWorker.setMaxAddr(pid, safeMaxAddr);
    console.log(`[setup] max_addr set to 0x${safeMaxAddr.toString(16)} (page ${lowestThreadTlsPage}) to protect thread region`);

    // BEAM emulator arguments
    // -root: OTP installation root
    // -progname: program name
    // -home: user home directory
    // +S 1:1: one normal scheduler, one dirty scheduler
    // +A 0: no async threads (reduce thread count)
    // +SDio 0: no dirty IO schedulers
    // +P 262144: max Erlang processes
    // -boot start_clean: use minimal boot script
    // -noshell: don't start the Erlang shell
    const userArgs = process.argv.slice(2);

    const beamArgs = [
        "beam.smp",
        // Emulator flags (use - prefix when calling beam directly, not +)
        "-S", "1:1",        // 1 normal scheduler, 1 online
        "-A", "0",           // no async threads
        "-SDio", "1",        // 1 dirty IO scheduler (minimum required)
        "-SDcpu", "1:1",     // 1 dirty CPU scheduler
        "-P", "262144",      // max Erlang processes
        "--",
        // Init flags (after --)
        "-root", installDir,
        "-bindir", resolve(installDir, "erts-16.1.2/bin"),
        "-progname", "erl",
        "-home", "/tmp",
        "-start_epmd", "false",  // don't start epmd (no distribution)
        "-boot", resolve(installDir, "releases/28/start_clean"),
        "-noshell",
        // "-init_debug",            // verbose init logging (enable for debugging)
        "-pa", ".", scriptDir,
        resolve(installDir, "lib/kernel-10.4.2/ebin"),
        resolve(installDir, "lib/stdlib-7.1/ebin"),
        ...userArgs,
    ];

    console.log("Starting BEAM emulator...");
    console.log("Args:", beamArgs.slice(1).join(" "));
    console.log("");

    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init",
        pid,
        ppid: 0,
        programBytes: beamBytes,
        memory,
        channelOffset,
        env: [
            "HOME=/tmp",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "TMPDIR=/tmp",
            "LANG=en_US.UTF-8",
            // BEAM requires these env vars (normally set by erlexec)
            `ROOTDIR=${installDir}`,
            `BINDIR=${installDir}/erts-16.1.2/bin`,
            `EMU=beam`,
            `PROGNAME=erl`,
        ],
        argv: beamArgs,
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

    // Detect stuck halt: BEAM's halt(0) gets stuck in pthread_join because
    // threads are blocked on futex waits. If output was produced and no new
    // output for 2s, BEAM is likely stuck — force clean exit.
    let exitResolve: (status: number) => void;
    const haltDetector = setInterval(() => {
        if (outputSeen && Date.now() - lastOutputTime > 2000) {
            clearInterval(haltDetector);
            exitResolve(0);
        }
    }, 500);

    const timeoutPromise = new Promise<number>((resolveP) => {
        exitResolve = resolveP;
        setTimeout(() => {
            clearInterval(haltDetector);
            console.log("\nTimeout reached. Forcing shutdown.");
            resolveP(1);
        }, 120_000);
    });

    const status = await Promise.race([exitPromise, timeoutPromise]);
    for (const [, w] of threadWorkers) {
        await w.terminate().catch(() => {});
    }
    for (const [, w] of workers) {
        await w.terminate().catch(() => {});
    }
    process.exit(status);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
