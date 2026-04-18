/**
 * Suite 5: MariaDB
 *
 * Bootstrap and query execution performance.
 *
 * Metrics:
 *   bootstrap_ms    — System table initialization
 *   query_create_ms — CREATE TABLE
 *   query_insert_ms — Batch INSERT (100 rows)
 *   query_select_ms — SELECT with WHERE clause
 *   query_join_ms   — JOIN across two tables
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createConnection, createServer, type Socket } from "net";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker.js";
import { NodePlatformIO } from "../../host/src/platform/node.js";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter.js";
import { patchWasmForThread } from "../../host/src/worker-main.js";
import { ThreadPageAllocator } from "../../host/src/thread-allocator.js";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");
const installDir = resolve(mariadbLibDir, "mariadb-install");
const mysqldPath = resolve(installDir, "bin/mariadbd");
const mysqlTestPath = resolve(installDir, "bin/mysqltest.wasm");
const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");

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
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    const sock: Socket = createConnection({ host: "127.0.0.1", port }, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

interface MariaDBInstance {
  kernelWorker: CentralizedKernelWorker;
  workers: Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>;
  port: number;
  cleanup: () => Promise<void>;
}

async function startMariaDB(dataDir: string, bootstrap: boolean): Promise<MariaDBInstance> {
  const port = await getFreePort();
  const kernelBytes = loadBytes(kernelWasmPath);
  const mysqldBytes = loadBytes(mysqldPath);

  const threadPatchedBytes = patchWasmForThread(mysqldBytes);
  const threadModule = new WebAssembly.Module(threadPatchedBytes);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
  const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((r) => { resolveExit = r; });

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true },
    io,
    {
      onFork: async (parentPid, childPid, parentMemory) => {
        const parentBuf = new Uint8Array(parentMemory.buffer);
        const parentPages = Math.ceil(parentBuf.byteLength / 65536);
        const childMemory = new WebAssembly.Memory({
          initial: parentPages, maximum: MAX_PAGES, shared: true,
        });
        if (parentPages < MAX_PAGES) childMemory.grow(MAX_PAGES - parentPages);
        new Uint8Array(childMemory.buffer).set(parentBuf);

        const childChannelOffset = (MAX_PAGES - 2) * 65536;
        new Uint8Array(childMemory.buffer, childChannelOffset, CH_TOTAL_SIZE).fill(0);
        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

        const ASYNCIFY_BUF_SIZE = 16384;
        const childWorker = workerAdapter.createWorker({
          type: "centralized_init",
          pid: childPid, ppid: parentPid,
          programBytes: mysqldBytes,
          memory: childMemory,
          channelOffset: childChannelOffset,
          isForkChild: true,
          asyncifyBufAddr: childChannelOffset - ASYNCIFY_BUF_SIZE,
        } as CentralizedWorkerInitMessage);
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

        const threadWorker = workerAdapter.createWorker({
          type: "centralized_thread_init",
          pid, tid,
          programBytes: mysqldBytes,
          programModule: threadModule,
          memory,
          channelOffset: alloc.channelOffset,
          fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr,
          tlsAllocAddr: alloc.tlsAllocAddr,
        } as CentralizedThreadInitMessage);
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
      onExec: async () => -38,
      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          kernelWorker.unregisterProcess(pid);
          resolveExit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(pid);
        }
        workers.delete(pid);
      },
    },
  );

  await kernelWorker.init(kernelBytes);
  kernelWorker.setOutputCallbacks({
    onStdout: () => {},
    onStderr: () => {},
  });

  const memory = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);

  kernelWorker.registerProcess(1, memory, [channelOffset]);
  kernelWorker.setCwd(1, dataDir);
  kernelWorker.setNextChildPid(2);

  const commonArgs = [
    "mariadbd", "--no-defaults",
    `--datadir=${dataDir}`,
    `--tmpdir=${resolve(dataDir, "tmp")}`,
    "--default-storage-engine=Aria",
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
  ];

  const serverArgs = bootstrap
    ? [...commonArgs, "--bootstrap", "--log-warnings=0"]
    : [...commonArgs, "--skip-networking=0", `--port=${port}`, "--bind-address=0.0.0.0", "--socket=", "--max-connections=10"];

  if (bootstrap) {
    const shareDir = resolve(installDir, "share/mysql");
    const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
    const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
    kernelWorker.setStdinData(1, new TextEncoder().encode(bootstrapSql));
  }

  const mainWorker = workerAdapter.createWorker({
    type: "centralized_init",
    pid: 1, ppid: 0,
    programBytes: mysqldBytes,
    memory, channelOffset,
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    argv: serverArgs,
  } as CentralizedWorkerInitMessage);
  workers.set(1, mainWorker);

  if (bootstrap) {
    const timeout = new Promise<number>((r) => setTimeout(() => r(0), 120_000));
    await Promise.race([exitPromise, timeout]);
  }

  const cleanup = async () => {
    for (const [, w] of workers) await w.terminate().catch(() => {});
  };

  return { kernelWorker, workers, port, cleanup };
}

async function runMysqlTest(
  instance: MariaDBInstance,
  sql: string,
): Promise<{ stdout: string; exitCode: number }> {
  const { runCentralizedProgram } = await import("../../host/test/centralized-test-helper.js");
  const result = await runCentralizedProgram({
    programPath: mysqlTestPath,
    argv: [
      "mysqltest",
      "--host=127.0.0.1",
      `--port=${instance.port}`,
      "--user=root",
      "--silent",
    ],
    stdin: sql,
    timeout: 120_000,
  });
  return { stdout: result.stdout, exitCode: result.exitCode };
}

const suite: BenchmarkSuite = {
  name: "mariadb",

  async run(): Promise<Record<string, number>> {
    if (!existsSync(mysqldPath)) {
      console.warn("  MariaDB not found, skipping. Run: bash examples/libs/mariadb/build-mariadb.sh");
      return {};
    }

    const results: Record<string, number> = {};

    // Use a fresh data directory for each run
    const dataDir = resolve(repoRoot, "benchmarks/results/.mariadb-bench-data");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
    mkdirSync(resolve(dataDir, "tmp"), { recursive: true });

    // 1. Bootstrap
    const t0 = performance.now();
    const bootstrapInstance = await startMariaDB(dataDir, true);
    await bootstrapInstance.cleanup();
    results.bootstrap_ms = performance.now() - t0;

    // 2. Start server
    const instance = await startMariaDB(dataDir, false);

    // Wait for TCP readiness
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await tryConnect(instance.port)) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      // 3. CREATE TABLE
      const t1 = performance.now();
      await runMysqlTest(instance, `
        CREATE DATABASE IF NOT EXISTS bench;
        USE bench;
        CREATE TABLE t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT);
        CREATE TABLE t2 (id INT PRIMARY KEY AUTO_INCREMENT, t1_id INT, data VARCHAR(200));
      `);
      results.query_create_ms = performance.now() - t1;

      // 4. INSERT 100 rows
      let insertSql = "USE bench;\n";
      for (let i = 0; i < 100; i++) {
        insertSql += `INSERT INTO t1 (name, value) VALUES ('item_${i}', ${i * 10});\n`;
      }
      for (let i = 0; i < 100; i++) {
        insertSql += `INSERT INTO t2 (t1_id, data) VALUES (${i + 1}, 'data_for_item_${i}');\n`;
      }
      const t2 = performance.now();
      await runMysqlTest(instance, insertSql);
      results.query_insert_ms = performance.now() - t2;

      // 5. SELECT with WHERE
      const t3 = performance.now();
      await runMysqlTest(instance, `
        USE bench;
        SELECT * FROM t1 WHERE value > 500 AND value < 800;
      `);
      results.query_select_ms = performance.now() - t3;

      // 6. JOIN
      const t4 = performance.now();
      await runMysqlTest(instance, `
        USE bench;
        SELECT t1.name, t2.data FROM t1 JOIN t2 ON t1.id = t2.t1_id WHERE t1.value > 500;
      `);
      results.query_join_ms = performance.now() - t4;
    } finally {
      await instance.cleanup();
    }

    // Cleanup data directory
    rmSync(dataDir, { recursive: true, force: true });

    return results;
  },
};

export default suite;
