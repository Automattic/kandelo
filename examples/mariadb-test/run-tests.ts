/**
 * MariaDB mysql-test suite runner for wasm-posix-kernel.
 *
 * Manages the full lifecycle:
 *   1. Bootstrap mariadbd (system tables) if needed
 *   2. Start mariadbd in server mode
 *   3. Wait for TCP readiness
 *   4. Run mysqltest for each .test file
 *   5. Output JSON lines with results
 *
 * Usage:
 *   npx tsx examples/mariadb-test/run-tests.ts [test1 test2 ...]
 *   npx tsx examples/mariadb-test/run-tests.ts --list
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { createConnection, createServer, type Socket } from "net";
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

const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");
const installDir = resolve(mariadbLibDir, "mariadb-install");
const mysqlTestDir = resolve(installDir, "mysql-test");

interface TestResult {
    test: string;
    status: "pass" | "fail" | "skip";
    time_ms: number;
    stderr?: string;
}

function loadBytes(path: string): ArrayBuffer {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

function tryConnect(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            sock.destroy();
            resolve(false);
        }, timeoutMs);
        const sock: Socket = createConnection({ host: "127.0.0.1", port }, () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(true);
        });
        sock.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

function discoverTests(): string[] {
    const mainDir = resolve(mysqlTestDir, "main");
    if (!existsSync(mainDir)) return [];
    return readdirSync(mainDir)
        .filter((f) => f.endsWith(".test"))
        .map((f) => f.replace(/\.test$/, ""))
        .sort();
}

// Module-level state
let serverStderr = "";
let tmpTestDir = "/tmp";
const clientExitResolvers = new Map<number, (status: number) => void>();
let _nextPid = 10;
function nextPid(): number { return _nextPid++; }

async function main() {
    const mysqldPath = resolve(installDir, "bin/mariadbd");
    const mysqlTestPath = resolve(installDir, "bin/mysqltest.wasm");
    const kernelPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");

    for (const [label, path] of [
        ["mariadbd", mysqldPath],
        ["mysqltest.wasm", mysqlTestPath],
        ["kernel wasm", kernelPath],
        ["mysql-test dir", mysqlTestDir],
    ] as const) {
        if (!existsSync(path)) {
            console.error(`ERROR: ${label} not found at ${path}`);
            process.exit(1);
        }
    }

    const args = process.argv.slice(2);
    if (args.includes("--list")) {
        const tests = discoverTests();
        console.log(`${tests.length} tests available:`);
        for (const t of tests) console.log(`  ${t}`);
        process.exit(0);
    }

    const testTimeout = parseInt(process.env.TEST_TIMEOUT ?? "60000", 10);

    let testNames: string[];
    if (args.length > 0 && !args[0].startsWith("--")) {
        testNames = args.filter((a) => !a.startsWith("--"));
    } else {
        testNames = discoverTests();
    }

    if (testNames.length === 0) {
        console.error("No tests found");
        process.exit(1);
    }

    // Load wasm binaries
    const kernelBytes = loadBytes(kernelPath);
    const mysqldBytes = loadBytes(mysqldPath);
    const mysqlTestBytes = loadBytes(mysqlTestPath);

    console.error(`Pre-compiling thread module...`);
    const threadPatchedBytes = patchWasmForThread(mysqldBytes);
    const threadModule = new WebAssembly.Module(threadPatchedBytes);
    console.error(`Thread module ready.`);

    // Create data directory
    const dataDir = resolve(scriptDir, "test-data");
    mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
    mkdirSync(resolve(dataDir, "tmp"), { recursive: true });
    tmpTestDir = resolve(dataDir, "tmp", "mysqltest");
    mkdirSync(tmpTestDir, { recursive: true });

    // --- Server lifecycle ---
    const io = new NodePlatformIO();
    const workerAdapter = new NodeWorkerAdapter();
    const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
    const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

    let resolveServerExit: ((status: number) => void) | null = null;
    let serverPort = 0;
    let needsRestart = false;

    // Create kernel worker once (persistent for entire session)
    const kernelWorker = new CentralizedKernelWorker(
        { maxWorkers: 16, dataBufferSize: 65536, useSharedMemory: true },
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
                if (parentPages < MAX_PAGES) childMemory.grow(MAX_PAGES - parentPages);
                new Uint8Array(childMemory.buffer).set(parentBuf);

                const childChannelOffset = (MAX_PAGES - 2) * 65536;
                new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);

                kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

                const ASYNCIFY_BUF_SIZE = 16384;
                const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
                const childInitData: CentralizedWorkerInitMessage = {
                    type: "centralized_init",
                    pid: childPid, ppid: parentPid,
                    programBytes: mysqldBytes, memory: childMemory,
                    channelOffset: childChannelOffset,
                    isForkChild: true, asyncifyBufAddr,
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
                const alloc = threadAllocator.allocate(memory);
                kernelWorker.addChannel(pid, alloc.channelOffset, tid);

                const threadInitData: CentralizedThreadInitMessage = {
                    type: "centralized_thread_init",
                    pid, tid,
                    programBytes: mysqldBytes,
                    programModule: threadModule,
                    memory,
                    channelOffset: alloc.channelOffset,
                    fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr,
                    tlsAllocAddr: alloc.tlsAllocAddr,
                };
                const threadWorker = workerAdapter.createWorker(threadInitData);
                threadWorker.on("message", (msg: unknown) => {
                    const m = msg as WorkerToHostMessage;
                    if (m.type === "thread_exit") {
                        kernelWorker.notifyThreadExit(pid, tid);
                        kernelWorker.removeChannel(pid, alloc.channelOffset);
                        threadAllocator.free(alloc.basePage);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", () => {
                    kernelWorker.notifyThreadExit(pid, tid);
                    kernelWorker.removeChannel(pid, alloc.channelOffset);
                    threadAllocator.free(alloc.basePage);
                });
                return tid;
            },

            onExec: async () => -38, // ENOSYS

            onExit: (exitPid, exitStatus) => {
                if (exitPid === 1) {
                    kernelWorker.unregisterProcess(exitPid);
                    if (resolveServerExit) resolveServerExit(exitStatus);
                } else {
                    const resolver = clientExitResolvers.get(exitPid);
                    if (resolver) resolver(exitStatus);
                    kernelWorker.deactivateProcess(exitPid);
                }
                workers.delete(exitPid);
            },
        },
    );

    await kernelWorker.init(kernelBytes);

    serverStderr = "";
    kernelWorker.setOutputCallbacks({
        onStdout: () => {},
        onStderr: (data) => {
            serverStderr += new TextDecoder().decode(data);
        },
    });

    // Bootstrap if needed
    const mysqlDir = resolve(dataDir, "mysql");
    if (readdirSync(mysqlDir).length === 0) {
        console.error("Bootstrapping MariaDB system tables...");
        await runBootstrap(kernelWorker, workerAdapter, workers, mysqldBytes, dataDir);
        console.error("Bootstrap complete.");
        serverStderr = "";
    }

    /** Kill all workers and start a fresh server instance. */
    async function restartServer(): Promise<void> {
        // Terminate all workers
        for (const [pid, w] of workers) {
            await w.terminate().catch(() => {});
            try { kernelWorker.unregisterProcess(pid); } catch {}
        }
        workers.clear();

        // Clean Aria control file to prevent checksum mismatch on restart
        const ariaControl = resolve(dataDir, "aria_log_control");
        const ariaLog = resolve(dataDir, "aria_log.00000001");
        try { if (existsSync(ariaControl)) { const { unlinkSync } = await import("fs"); unlinkSync(ariaControl); } } catch {}
        try { if (existsSync(ariaLog)) { const { unlinkSync } = await import("fs"); unlinkSync(ariaLog); } } catch {}

        serverPort = await getFreePort();
        console.error(`Starting MariaDB on port ${serverPort}...`);
        resolveServerExit = null;

        startServer(kernelWorker, workerAdapter, workers, mysqldBytes, dataDir, serverPort);

        // Wait for TCP readiness
        for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await tryConnect(serverPort)) {
                console.error("MariaDB is ready.");
                return;
            }
        }
        throw new Error("MariaDB did not become ready within 60s");
    }

    /** Run the setup SQL to create mtr database. */
    async function runSetup(): Promise<void> {
        const setupSql = resolve(dataDir, "tmp", "setup.test");
        writeFileSync(setupSql, `
CREATE DATABASE IF NOT EXISTS mtr;
USE mtr;
CREATE TABLE IF NOT EXISTS test_suppressions (pattern VARCHAR(255));
DROP PROCEDURE IF EXISTS add_suppression;
delimiter |;
CREATE DEFINER='root'@'localhost' PROCEDURE add_suppression(pattern VARCHAR(255))
BEGIN
  INSERT INTO test_suppressions (pattern) VALUES (pattern);
END|
delimiter ;|
# Ensure root has passwordless TCP access from all hosts.
# Some tests call FLUSH PRIVILEGES which re-enables grant checking.
# Without these entries, root@127.0.0.1 gets "Access denied" over TCP.
REPLACE INTO mysql.global_priv VALUES ('localhost','root','{"access":18446744073709551615}');
REPLACE INTO mysql.global_priv VALUES ('127.0.0.1','root','{"access":18446744073709551615}');
REPLACE INTO mysql.global_priv VALUES ('%','root','{"access":18446744073709551615}');
FLUSH PRIVILEGES;
`);
        const r = await runMysqlTest(
            kernelWorker, workerAdapter, workers, mysqlTestBytes,
            "__setup", setupSql, "", serverPort, 30000,
        );
        if (r.status !== "pass") {
            console.error("WARNING: setup SQL failed:", r.stderr);
        }
    }

    // Initial server start
    await restartServer();
    await runSetup();

    // --- Run tests ---
    const results: TestResult[] = [];
    const resetSql = resolve(dataDir, "tmp", "reset.test");
    writeFileSync(resetSql, "DROP DATABASE IF EXISTS test;\nCREATE DATABASE test;\n");

    for (const testName of testNames) {
        // Restart server if previous test caused issues
        if (needsRestart) {
            console.error("Restarting server after previous timeout...");
            try {
                await restartServer();
                await runSetup();
                needsRestart = false;
            } catch (e) {
                console.error("Server restart failed:", e);
                // Mark remaining tests as fail
                results.push({ test: testName, status: "fail", time_ms: 0, stderr: "server restart failed" });
                outputResult(results[results.length - 1]);
                continue;
            }
        }

        const testFile = resolve(mysqlTestDir, "main", `${testName}.test`);
        const resultFile = resolve(mysqlTestDir, "main", `${testName}.result`);

        if (!existsSync(testFile)) {
            results.push({ test: testName, status: "skip", time_ms: 0, stderr: "test file not found" });
            outputResult(results[results.length - 1]);
            continue;
        }

        // Reset test database (non-fatal)
        try {
            await runMysqlTest(
                kernelWorker, workerAdapter, workers, mysqlTestBytes,
                "__reset", resetSql, "", serverPort, 15000,
            );
        } catch {
            // Reset failed — server may be stuck. Set restart flag.
            needsRestart = true;
        }

        if (needsRestart) {
            // Don't run the test — restart first on next iteration
            console.error(`Restarting server before ${testName}...`);
            try {
                await restartServer();
                await runSetup();
                needsRestart = false;
                // Retry reset
                try {
                    await runMysqlTest(
                        kernelWorker, workerAdapter, workers, mysqlTestBytes,
                        "__reset", resetSql, "", serverPort, 15000,
                    );
                } catch {}
            } catch (e) {
                results.push({ test: testName, status: "fail", time_ms: 0, stderr: "server restart failed" });
                outputResult(results[results.length - 1]);
                continue;
            }
        }

        const start = Date.now();
        let result: TestResult;
        try {
            result = await runMysqlTest(
                kernelWorker, workerAdapter, workers, mysqlTestBytes,
                testName, testFile, resultFile, serverPort, testTimeout,
            );
        } catch (e: unknown) {
            const elapsed = Date.now() - start;
            const errMsg = e instanceof Error ? e.message : String(e);
            result = { test: testName, status: "fail", time_ms: elapsed, stderr: errMsg };
        }
        results.push(result);
        outputResult(result);
    }

    // Tear down
    for (const [, w] of workers) {
        await w.terminate().catch(() => {});
    }

    const pass = results.filter((r) => r.status === "pass").length;
    const fail = results.filter((r) => r.status === "fail").length;
    const skip = results.filter((r) => r.status === "skip").length;
    console.error(`\nResults: ${pass} pass, ${fail} fail, ${skip} skip (${results.length} total)`);

    process.exit(fail > 0 ? 1 : 0);
}

function outputResult(result: TestResult) {
    console.log(JSON.stringify(result));
}

/** Run mariadbd in bootstrap mode. */
async function runBootstrap(
    kernelWorker: CentralizedKernelWorker,
    workerAdapter: NodeWorkerAdapter,
    workers: Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>,
    mysqldBytes: ArrayBuffer,
    dataDir: string,
) {
    const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, dataDir);
    kernelWorker.setNextChildPid(2);

    const shareDir = resolve(installDir, "share/mysql");
    const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
    const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
    kernelWorker.setStdinData(pid, new TextEncoder().encode(bootstrapSql));

    const argv = [
        "mariadbd", "--no-defaults",
        `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
        "--default-storage-engine=Aria", "--skip-grant-tables",
        "--key-buffer-size=1048576", "--table-open-cache=10",
        "--sort-buffer-size=262144", "--bootstrap", "--log-warnings=0",
    ];

    let resolveExit: (status: number) => void;
    const exitPromise = new Promise<number>((r) => { resolveExit = r; });

    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init", pid, ppid: 0,
        programBytes: mysqldBytes, memory, channelOffset,
        env: ["HOME=/tmp", "PATH=/usr/bin", "TMPDIR=/tmp"], argv,
    };

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);
    worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exit") resolveExit(m.status);
    });

    const timeout = new Promise<number>((r) => setTimeout(() => r(0), 60000));
    await Promise.race([exitPromise, timeout]);
    await worker.terminate().catch(() => {});
    kernelWorker.unregisterProcess(pid);
    workers.delete(pid);
}

/** Start mariadbd in server mode (non-blocking). */
function startServer(
    kernelWorker: CentralizedKernelWorker,
    workerAdapter: NodeWorkerAdapter,
    workers: Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>,
    mysqldBytes: ArrayBuffer,
    dataDir: string,
    port: number,
) {
    const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    const pid = 1;
    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, dataDir);
    kernelWorker.setNextChildPid(2);

    const argv = [
        "mariadbd", "--no-defaults",
        `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
        "--default-storage-engine=Aria", "--skip-grant-tables",
        "--key-buffer-size=1048576", "--table-open-cache=10",
        "--sort-buffer-size=262144", "--skip-networking=0",
        `--port=${port}`, "--bind-address=0.0.0.0", "--socket=",
        "--max-connections=50", "--wait-timeout=10",
        "--net-read-timeout=10", "--net-write-timeout=10",
        "--lock-wait-timeout=10", "--thread-handling=no-threads",
    ];

    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init", pid, ppid: 0,
        programBytes: mysqldBytes, memory, channelOffset,
        env: ["HOME=/tmp", "PATH=/usr/bin", "TMPDIR=/tmp"], argv,
    };

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);
    worker.on("error", () => {});
}

/** Run a single mysqltest against the running server. */
async function runMysqlTest(
    kernelWorker: CentralizedKernelWorker,
    workerAdapter: NodeWorkerAdapter,
    workers: Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>,
    mysqlTestBytes: ArrayBuffer,
    testName: string,
    testFile: string,
    resultFile: string,
    port: number,
    timeout: number,
): Promise<TestResult> {
    const pid = nextPid();
    const start = Date.now();

    const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
    const channelOffset = (MAX_PAGES - 2) * 65536;
    memory.grow(MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, mysqlTestDir);

    const argv = [
        "mysqltest", "--no-defaults",
        `--host=127.0.0.1`, `--port=${port}`,
        `--user=root`, `--database=test`,
        `--test-file=${testFile}`,
        `--basedir=${mysqlTestDir}`,
        `--tmpdir=${tmpTestDir}`,
        `--silent`,
        `--protocol=tcp`,
    ];

    // Result comparison modes
    const recordMode = process.env.RECORD === "1";
    const skipResult = process.env.SKIP_RESULT === "1";
    if (existsSync(resultFile) && !skipResult) {
        if (recordMode) {
            argv.push(`--result-file=${resultFile}`, `--record`);
        } else {
            argv.push(`--result-file=${resultFile}`);
        }
    }

    const prevStderr = serverStderr;

    let resolveExit: (status: number) => void;
    let rejectExit: (err: Error) => void;
    const exitPromise = new Promise<number>((res, rej) => {
        resolveExit = res;
        rejectExit = rej;
    });

    clientExitResolvers.set(pid, resolveExit!);

    const initData: CentralizedWorkerInitMessage = {
        type: "centralized_init", pid, ppid: 0,
        programBytes: mysqlTestBytes, memory, channelOffset,
        env: [
            "HOME=/tmp", "PATH=/usr/bin", "TMPDIR=/tmp",
            `MYSQL_TEST_DIR=${mysqlTestDir}`,
            `MYSQLTEST_VARDIR=${resolve(scriptDir, "test-data")}`,
            `MYSQL_TMP_DIR=${tmpTestDir}`,
        ],
        argv,
    };

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);

    worker.on("error", (err: Error) => { rejectExit(err); });

    const timer = setTimeout(() => {
        worker.terminate().catch(() => {});
        rejectExit(new Error(`Test ${testName} timed out after ${timeout}ms`));
    }, timeout);

    let exitCode: number;
    try {
        exitCode = await exitPromise;
    } finally {
        clearTimeout(timer);
        clientExitResolvers.delete(pid);
        await worker.terminate().catch(() => {});
        kernelWorker.unregisterProcess(pid);
        workers.delete(pid);
    }

    const elapsed = Date.now() - start;
    const capturedStderr = serverStderr.slice(prevStderr.length);

    let status: "pass" | "fail" | "skip";
    if (exitCode === 0) status = "pass";
    else if (exitCode === 62) status = "skip";
    else status = "fail";

    return {
        test: testName,
        status,
        time_ms: elapsed,
        stderr: capturedStderr.length > 0 ? capturedStderr.slice(-2000) : undefined,
    };
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
