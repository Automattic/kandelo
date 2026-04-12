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

/** Patch include files to work in our wasm environment. */
function patchIncludeFiles(testDir: string) {
    const includeDir = resolve(testDir, "include");
    const patches: [string, RegExp, string][] = [
        // Replace --exec echo "..." with --echo ... (no shell available)
        ["start_mysqld.inc", /--exec echo "(.*)"/g, "--echo $1"],
        // Replace --exec echo '...' variant too
        ["start_mysqld.inc", /--exec echo '(.*)'/g, "--echo $1"],
    ];
    for (const [file, pattern, replacement] of patches) {
        const filePath = resolve(includeDir, file);
        try {
            const content = readFileSync(filePath, "utf-8");
            const patched = content.replace(pattern, replacement);
            if (patched !== content) {
                writeFileSync(filePath, patched);
                console.error(`Patched ${file}`);
            }
        } catch {}
    }
}

// Module-level state
let serverStderr = "";
let tmpTestDir = "/tmp";
const clientExitResolvers = new Map<number, (status: number) => void>();
let _nextPid = 10;
function nextPid(): number { return _nextPid++; }

// Server mid-test restart state
let autoRestartOnServerExit = false;
let serverRestartPromise: Promise<boolean> | null = null;
const serverThreadWorkers = new Set<ReturnType<NodeWorkerAdapter["createWorker"]>>();

// Track current running test for thread crash abort
let currentTestReject: ((err: Error) => void) | null = null;
let currentTestWorker: ReturnType<NodeWorkerAdapter["createWorker"]> | null = null;
let needsRestart = false;

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

    const testTimeout = parseInt(process.env.TEST_TIMEOUT ?? "300000", 10);

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

    // Patch include files: replace --exec echo with --echo (no shell in wasm)
    patchIncludeFiles(mysqlTestDir);

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
    let threadAllocator = new ThreadPageAllocator(MAX_PAGES);

    let resolveServerExit: ((status: number) => void) | null = null;
    let serverPort = 0;

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
                serverThreadWorkers.add(threadWorker);
                threadWorker.on("message", (msg: unknown) => {
                    const m = msg as WorkerToHostMessage;
                    if (m.type === "thread_exit") {
                        serverThreadWorkers.delete(threadWorker);
                        kernelWorker.notifyThreadExit(pid, tid);
                        kernelWorker.removeChannel(pid, alloc.channelOffset);
                        threadAllocator.free(alloc.basePage);
                        threadWorker.terminate().catch(() => {});
                    }
                });
                threadWorker.on("error", (err) => {
                    serverThreadWorkers.delete(threadWorker);
                    try { kernelWorker.notifyThreadExit(pid, tid); } catch {}
                    try { kernelWorker.removeChannel(pid, alloc.channelOffset); } catch {}
                    threadAllocator.free(alloc.basePage);
                    // Server thread crashed — mark for restart and abort current test
                    const msg = err?.message || "server thread crashed";
                    console.error(`[thread-worker] tid=${tid} CAUGHT ERROR: ${msg}`);
                    needsRestart = true;
                    if (currentTestReject) {
                        currentTestWorker?.terminate().catch(() => {});
                        currentTestReject(new Error(`Server thread crash: ${msg}`));
                        currentTestReject = null;
                        currentTestWorker = null;
                    }
                });
                return tid;
            },

            onExec: async () => -38, // ENOSYS

            onExit: (exitPid, exitStatus) => {
                if (exitPid === 1) {
                    kernelWorker.unregisterProcess(exitPid);
                    workers.delete(exitPid);
                    if (autoRestartOnServerExit) {
                        // Server shutdown mid-test — auto-restart
                        console.error(`[restart] Server exited (status=${exitStatus}), auto-restarting on port ${serverPort}...`);
                        serverRestartPromise = performMidTestRestart(
                            kernelWorker, workerAdapter, workers, mysqldBytes, dataDir, serverPort,
                        );
                    } else if (resolveServerExit) {
                        resolveServerExit(exitStatus);
                    }
                } else {
                    const resolver = clientExitResolvers.get(exitPid);
                    if (resolver) resolver(exitStatus);
                    kernelWorker.deactivateProcess(exitPid);
                    workers.delete(exitPid);
                }
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

    // .expect file path for MTR restart protocol
    const expectFilePath = resolve(dataDir, "tmp", "tmp.expect");

    /** Perform mid-test server restart (called from onExit when server shuts down). */
    async function performMidTestRestart(
        kw: CentralizedKernelWorker,
        wa: NodeWorkerAdapter,
        ws: Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>,
        serverBytes: ArrayBuffer,
        dDir: string,
        port: number,
    ): Promise<boolean> {
        // Terminate remaining server thread workers
        for (const tw of serverThreadWorkers) {
            await tw.terminate().catch(() => {});
        }
        serverThreadWorkers.clear();
        threadAllocator = new ThreadPageAllocator(MAX_PAGES);

        // Clean Aria control/log files
        const { unlinkSync, readdirSync: readdir, readFileSync: readf } = await import("fs");
        for (const f of readdir(dDir)) {
            if (f.startsWith("aria_log")) {
                try { unlinkSync(resolve(dDir, f)); } catch {}
            }
        }

        // Read .expect file for restart options
        let extraArgs: string[] = [];
        try {
            const content = readf(expectFilePath, "utf-8").trim();
            const lastLine = content.split("\n").pop()?.trim() ?? "";
            if (lastLine.startsWith("restart:")) {
                const opts = lastLine.slice("restart:".length).trim();
                if (opts.length > 0) {
                    extraArgs = opts.split(/\s+/);
                    console.error(`[restart] With options: ${extraArgs.join(" ")}`);
                }
            }
        } catch {}

        // Start server on same port with optional extra args
        startServer(kw, wa, ws, serverBytes, dDir, port, extraArgs);

        // Wait for TCP readiness
        for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await tryConnect(port)) {
                console.error(`[restart] Server restarted successfully.`);
                return true;
            }
        }
        console.error(`[restart] Server failed to restart within 60s.`);
        return false;
    }

    let restartFailCount = 0;

    /** Kill all workers and start a fresh server instance. */
    async function restartServer(): Promise<void> {
        // Terminate all workers (including server threads)
        for (const tw of serverThreadWorkers) {
            await tw.terminate().catch(() => {});
        }
        serverThreadWorkers.clear();
        for (const [pid, w] of workers) {
            await w.terminate().catch(() => {});
            try { kernelWorker.unregisterProcess(pid); } catch {}
        }
        workers.clear();
        threadAllocator = new ThreadPageAllocator(MAX_PAGES);

        // Clean Aria control/log files to prevent checksum mismatch on restart
        const { unlinkSync, readdirSync: readdir } = await import("fs");
        for (const f of readdir(dataDir)) {
            if (f.startsWith("aria_log")) {
                try { unlinkSync(resolve(dataDir, f)); } catch {}
            }
        }

        // Force GC to reclaim terminated worker memory (especially 1GB Wasm memories)
        if (typeof globalThis.gc === "function") {
            globalThis.gc();
            globalThis.gc(); // Double GC: first pass marks, second pass sweeps Wasm
        }

        // If restart has failed repeatedly, reinitialize the kernel entirely
        if (restartFailCount >= 2) {
            console.error("Reinitializing kernel after repeated restart failures...");
            await kernelWorker.init(kernelBytes);
            restartFailCount = 0;
        }

        serverPort = await getFreePort();
        console.error(`Starting MariaDB on port ${serverPort}...`);
        resolveServerExit = null;

        startServer(kernelWorker, workerAdapter, workers, mysqldBytes, dataDir, serverPort);

        // Wait for TCP readiness
        for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await tryConnect(serverPort)) {
                console.error("MariaDB is ready.");
                restartFailCount = 0;
                return;
            }
        }
        restartFailCount++;
        throw new Error("MariaDB did not become ready within 60s");
    }

    /** Run the setup SQL to create mtr database. */
    async function runSetup(): Promise<void> {
        const setupSql = resolve(dataDir, "tmp", "setup.test");
        writeFileSync(setupSql, `
CREATE DATABASE IF NOT EXISTS test;
CREATE DATABASE IF NOT EXISTS mtr;
USE mtr;
CREATE TABLE IF NOT EXISTS test_suppressions (pattern VARCHAR(255));
# Create mysql.proc if it doesn't exist (needed for stored procedure tests)
CREATE TABLE IF NOT EXISTS mysql.proc (
  db char(64) NOT NULL DEFAULT '',
  name char(64) NOT NULL DEFAULT '',
  type enum('FUNCTION','PROCEDURE') NOT NULL,
  specific_name char(64) NOT NULL DEFAULT '',
  language enum('SQL') DEFAULT 'SQL' NOT NULL,
  sql_data_access enum('CONTAINS_SQL','NO_SQL','READS_SQL_DATA','MODIFIES_SQL_DATA') DEFAULT 'CONTAINS_SQL' NOT NULL,
  is_deterministic enum('YES','NO') NOT NULL DEFAULT 'NO',
  security_type enum('INVOKER','DEFINER') DEFAULT 'DEFINER' NOT NULL,
  param_list blob NOT NULL,
  returns longblob NOT NULL,
  body longblob NOT NULL,
  definer char(141) NOT NULL DEFAULT '',
  created timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  modified timestamp NOT NULL DEFAULT '0000-00-00 00:00:00',
  sql_mode set('REAL_AS_FLOAT','PIPES_AS_CONCAT','ANSI_QUOTES','IGNORE_SPACE','IGNORE_BAD_TABLE_OPTIONS','ONLY_FULL_GROUP_BY','NO_UNSIGNED_SUBTRACTION','NO_DIR_IN_CREATE','POSTGRESQL','ORACLE','MSSQL','DB2','MAXDB','NO_KEY_OPTIONS','NO_TABLE_OPTIONS','NO_FIELD_OPTIONS','MYSQL323','MYSQL40','ANSI','NO_AUTO_VALUE_ON_ZERO','NO_BACKSLASH_ESCAPES','STRICT_TRANS_TABLES','STRICT_ALL_TABLES','NO_ZERO_IN_DATE','NO_ZERO_DATE','INVALID_DATES','ERROR_FOR_DIVISION_BY_ZERO','TRADITIONAL','NO_AUTO_CREATE_USER','HIGH_NOT_PRECEDENCE','NO_ENGINE_SUBSTITUTION','PAD_CHAR_TO_FULL_LENGTH','EMPTY_STRING_IS_NULL','SIMULTANEOUS_ASSIGNMENT') DEFAULT '' NOT NULL,
  comment text NOT NULL,
  character_set_client char(32) DEFAULT NULL,
  collation_connection char(32) DEFAULT NULL,
  db_collation char(32) DEFAULT NULL,
  body_utf8 longblob,
  aggregate enum('NONE','GROUP') DEFAULT 'NONE' NOT NULL,
  PRIMARY KEY (db,name,type)
) engine=Aria;
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
# Create mariadb.sys user needed by some system views
REPLACE INTO mysql.global_priv VALUES ('localhost','mariadb.sys','{"access":0}');
# Create mysql.servers table if missing
CREATE TABLE IF NOT EXISTS mysql.servers (
  Server_name char(64) NOT NULL DEFAULT '',
  Host char(255) NOT NULL DEFAULT '',
  Db char(64) NOT NULL DEFAULT '',
  Username char(64) NOT NULL DEFAULT '',
  Password char(64) NOT NULL DEFAULT '',
  Port int(4) DEFAULT 0 NOT NULL,
  Socket char(64) NOT NULL DEFAULT '',
  Wrapper char(64) NOT NULL DEFAULT '',
  Owner char(64) NOT NULL DEFAULT '',
  PRIMARY KEY (Server_name)
) engine=Aria;
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

    // Create std_data symlink relative to datadir so LOAD DATA INFILE '../../std_data/...' works
    const stdDataLink = resolve(dataDir, "..", "..", "std_data");
    const stdDataTarget = resolve(mysqlTestDir, "std_data");
    try {
        const { symlinkSync, lstatSync } = await import("fs");
        try { lstatSync(stdDataLink); } catch {
            symlinkSync(stdDataTarget, stdDataLink);
        }
    } catch {}

    // --- Run tests ---
    const results: TestResult[] = [];
    const resetSql = resolve(dataDir, "tmp", "reset.test");
    // Drop user-created databases and reset between tests
    writeFileSync(resetSql, `--disable_abort_on_error
DROP DATABASE IF EXISTS test;
DROP DATABASE IF EXISTS db;
DROP DATABASE IF EXISTS db1;
DROP DATABASE IF EXISTS db2;
DROP DATABASE IF EXISTS mysqltest;
DROP DATABASE IF EXISTS mysqltest1;
DROP DATABASE IF EXISTS mysqltest2;
DROP DATABASE IF EXISTS mysqltest_1;
DROP DATABASE IF EXISTS events_test;
DROP DATABASE IF EXISTS tmp;
DROP DATABASE IF EXISTS client_test_db;
--enable_abort_on_error
CREATE DATABASE test;
`);

    let consecutiveRestartFailures = 0;
    const MAX_CONSECUTIVE_RESTART_FAILURES = 5;
    // Hard per-iteration timeout: test timeout + 120s for reset/restart overhead
    const iterationTimeout = testTimeout + 120000;

    for (const testName of testNames) {
        // Run GC before each test to keep memory pressure low
        if (typeof globalThis.gc === "function") {
            globalThis.gc();
        }

        // Wrap entire iteration in a hard timeout to prevent hangs
        const iterationResult = await Promise.race([
            runTestIteration(testName),
            new Promise<TestResult>((resolve) =>
                setTimeout(() => resolve({
                    test: testName, status: "fail" as const, time_ms: iterationTimeout,
                    stderr: `Hard timeout: test iteration exceeded ${iterationTimeout}ms`,
                }), iterationTimeout)
            ),
        ]);

        results.push(iterationResult);
        outputResult(iterationResult);
        const errText = iterationResult.stderr || "";
        if (iterationResult.status === "fail" && (
            errText.includes("Could not open connection") ||
            errText.includes("Can't connect to") ||
            errText.includes("timed out") ||
            errText.includes("null function or function signature") ||
            errText.includes("Aborting") ||
            errText.includes("Server thread crash") ||
            errText.includes("table index is out of bounds") ||
            errText.includes("Hard timeout")
        )) {
            needsRestart = true;
        }
    }

    async function runTestIteration(testName: string): Promise<TestResult> {
        // Restart server if previous test caused issues
        if (needsRestart) {
            if (consecutiveRestartFailures >= MAX_CONSECUTIVE_RESTART_FAILURES) {
                // Nuclear recovery: re-bootstrap from scratch
                console.error("Server unrecoverable — re-bootstrapping from scratch...");
                try {
                    // Clean data directory
                    const { rmSync, mkdirSync: mkd } = await import("fs");
                    rmSync(dataDir, { recursive: true, force: true });
                    mkd(resolve(dataDir, "mysql"), { recursive: true });
                    mkd(resolve(dataDir, "tmp"), { recursive: true });
                    tmpTestDir = resolve(dataDir, "tmp", "mysqltest");
                    mkd(tmpTestDir, { recursive: true });
                    // Reinit kernel and re-bootstrap
                    await kernelWorker.init(kernelBytes);
                    await runBootstrap(kernelWorker, workerAdapter, workers, mysqldBytes, dataDir);
                    await restartServer();
                    await runSetup();
                    needsRestart = false;
                    consecutiveRestartFailures = 0;
                    console.error("Re-bootstrap complete.");
                } catch (e) {
                    console.error("Re-bootstrap failed:", e);
                    return { test: testName, status: "fail", time_ms: 0, stderr: "re-bootstrap failed" };
                }
            } else {
                console.error("Restarting server after previous timeout...");
                try {
                    await restartServer();
                    await runSetup();
                    needsRestart = false;
                    consecutiveRestartFailures = 0;
                } catch (e) {
                    consecutiveRestartFailures++;
                    console.error(`Server restart failed (${consecutiveRestartFailures}/${MAX_CONSECUTIVE_RESTART_FAILURES}):`, e);
                    return { test: testName, status: "fail", time_ms: 0, stderr: "server restart failed" };
                }
            }
        }

        const testFile = resolve(mysqlTestDir, "main", `${testName}.test`);
        const resultFile = resolve(mysqlTestDir, "main", `${testName}.result`);

        if (!existsSync(testFile)) {
            return { test: testName, status: "skip", time_ms: 0, stderr: "test file not found" };
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
            // Don't run the test — restart first
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
                return { test: testName, status: "fail", time_ms: 0, stderr: "server restart failed" };
            }
        }

        // Enable auto-restart during test execution
        autoRestartOnServerExit = true;
        serverRestartPromise = null;

        // Clean stale .expect file before test
        try { const { unlinkSync: ul } = await import("fs"); ul(expectFilePath); } catch {}

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

        autoRestartOnServerExit = false;

        // If a mid-test restart was triggered, wait for it to complete
        if (serverRestartPromise) {
            const ok = await serverRestartPromise;
            serverRestartPromise = null;
            if (!ok) {
                needsRestart = true;
            }
        }

        return result;
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

    // Temporarily route output to stderr during bootstrap
    const prevCallbacks = { onStdout: () => {}, onStderr: (data: Uint8Array) => { serverStderr += new TextDecoder().decode(data); } };
    const decoder = new TextDecoder();
    kernelWorker.setOutputCallbacks({
        onStdout: (data) => process.stderr.write(decoder.decode(data)),
        onStderr: (data) => process.stderr.write(decoder.decode(data)),
    });

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);
    worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exit") resolveExit(m.status);
        else if (m.type === "error") {
            console.error(`[bootstrap] worker error: ${(m as any).message}`);
            resolveExit(1);
        }
    });
    worker.on("error", (err: Error) => {
        console.error(`[bootstrap] worker crash: ${err.message}`);
        resolveExit(1);
    });

    const timeout = new Promise<number>((r) => setTimeout(() => r(0), 60000));
    const status = await Promise.race([exitPromise, timeout]);
    if (status !== 0) console.error(`[bootstrap] exit status: ${status}`);

    // Restore output callbacks
    kernelWorker.setOutputCallbacks(prevCallbacks);
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
    extraArgs: string[] = [],
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
        "--lock-wait-timeout=10",
        `--lc-messages-dir=${resolve(installDir, "share")}`,
        ...extraArgs,
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

    // mysqltest needs much less memory than mariadbd — use 2048 pages (128MB) max
    const CLIENT_MAX_PAGES = 2048;
    const memory = new WebAssembly.Memory({ initial: 17, maximum: CLIENT_MAX_PAGES, shared: true });
    const channelOffset = (CLIENT_MAX_PAGES - 2) * 65536;
    memory.grow(CLIENT_MAX_PAGES - 17);
    new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

    kernelWorker.registerProcess(pid, memory, [channelOffset]);
    kernelWorker.setCwd(pid, mysqlTestDir);

    // Setup/reset operations use "mysql" database; real tests use "test"
    const isInternal = testName.startsWith("__");
    const database = isInternal ? "mysql" : "test";

    const argv = [
        "mysqltest", "--no-defaults",
        `--host=127.0.0.1`, `--port=${port}`,
        `--user=root`, `--database=${database}`,
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
            // Standard MTR environment variables expected by test scripts
            `MASTER_MYPORT=${port}`,
            `MASTER_MYPORT1=${port}`,
            `MASTER_MYSOCK=/tmp/mysql.sock`,
            `MYSQLD_DATADIR=${resolve(scriptDir, "test-data")}`,
            `MYSQL_BINDIR=${resolve(installDir, "bin")}`,
            `MYSQL_SHAREDIR=${resolve(installDir, "share")}`,
            `MYSQL_LIBDIR=${resolve(installDir, "lib")}`,
        ],
        argv,
    };

    const worker = workerAdapter.createWorker(initData);
    workers.set(pid, worker);

    worker.on("error", (err: Error) => { rejectExit(err); });

    // Track current test worker so thread crash handler can abort it
    currentTestReject = rejectExit;
    currentTestWorker = worker;

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
        if (currentTestWorker === worker) {
            currentTestReject = null;
            currentTestWorker = null;
        }
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
