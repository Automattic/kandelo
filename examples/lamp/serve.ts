/**
 * serve.ts — Full LAMP stack on wasm-posix-kernel.
 *
 * Runs MariaDB + PHP-FPM + nginx as separate Wasm processes in one kernel:
 *   - MariaDB   (pid 1, threads for signal handler + timer)
 *   - PHP-FPM   (pid 3, forks 1 worker → pid 4)
 *   - nginx     (pid 5, forks 2 workers → pid 6, 7)
 *
 * All inter-process communication (FastCGI, MySQL protocol) flows through
 * the kernel's cross-process loopback TCP.
 *
 * Usage:
 *   npx tsx examples/lamp/serve.ts [port]
 *
 * Requires:
 *   1. MariaDB:  examples/libs/mariadb/mariadb-install/bin/mariadbd
 *   2. PHP-FPM:  examples/nginx/php-fpm.wasm (with --with-pdo-mysql)
 *   3. nginx:    examples/nginx/nginx.wasm
 *   4. WordPress: examples/lamp/wordpress/
 *      (download with: bash examples/lamp/setup.sh)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import { ThreadPageAllocator } from "../../host/src/thread-allocator";
import { patchWasmForThread } from "../../host/src/worker-main";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol";

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

// Binary paths
const mariadbInstall = resolve(repoRoot, "examples/libs/mariadb/mariadb-install");
const mysqldPath = resolve(mariadbInstall, "bin/mariadbd");
const phpFpmWasmPath = resolve(repoRoot, "examples/nginx/php-fpm.wasm");
const nginxWasmPath = resolve(repoRoot, "examples/nginx/nginx.wasm");
const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");

// WordPress and config paths
const wpDir = resolve(scriptDir, "wordpress");
const confTemplate = resolve(scriptDir, "nginx.conf");
const phpFpmConf = resolve(scriptDir, "php-fpm.conf");
const routerScript = resolve(scriptDir, "fpm-router.php");

// MariaDB data directory
const dataDir = resolve(scriptDir, "data");

const port = parseInt(process.argv[2] || "8080", 10);

// Validate prerequisites
for (const [name, path, hint] of [
  ["mariadbd", mysqldPath, "bash examples/libs/mariadb/build-mariadb.sh"],
  ["php-fpm.wasm", phpFpmWasmPath, "bash examples/nginx/build-php-fpm.sh"],
  ["nginx.wasm", nginxWasmPath, "bash examples/nginx/build.sh"],
  ["kernel wasm", kernelWasmPath, "bash build.sh"],
] as const) {
  if (!existsSync(path)) {
    console.error(`Error: ${name} not found. Run: ${hint}`);
    process.exit(1);
  }
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash examples/lamp/setup.sh");
  process.exit(1);
}

// Create directories
mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
mkdirSync(resolve(dataDir, "tmp"), { recursive: true });
for (const dir of ["client_body_temp", "fastcgi_temp", "logs"]) {
  mkdirSync(join("/tmp/nginx-wasm", dir), { recursive: true });
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function createProcessMemory(): { memory: WebAssembly.Memory; channelOffset: number } {
  const memory = new WebAssembly.Memory({
    initial: 17,
    maximum: MAX_PAGES,
    shared: true,
  });
  const channelOffset = (MAX_PAGES - 2) * 65536;
  memory.grow(MAX_PAGES - 17);
  new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE).fill(0);
  return { memory, channelOffset };
}

function generateNginxConf(): string {
  let conf = readFileSync(confTemplate, "utf-8");
  conf = conf.replace(/WORDPRESS_ROOT/g, wpDir);
  conf = conf.replace(/ROUTER_SCRIPT/g, routerScript);
  conf = conf.replace("listen 8080", `listen ${port}`);
  const outPath = "/tmp/nginx-wasm/lamp-nginx.conf";
  writeFileSync(outPath, conf);
  return outPath;
}

async function main() {
  const kernelBytes = loadBytes(kernelWasmPath);
  const mysqldBytes = loadBytes(mysqldPath);
  const phpFpmBytes = loadBytes(phpFpmWasmPath);
  const nginxBytes = loadBytes(nginxWasmPath);

  // Pre-compile MariaDB thread module
  console.log("Pre-compiling MariaDB thread module...");
  const threadPatchedBytes = patchWasmForThread(mysqldBytes);
  const threadModule = new WebAssembly.Module(threadPatchedBytes);
  console.log("Thread module ready.");

  const io = new NodePlatformIO();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
  const pidProgram = new Map<number, ArrayBuffer>();

  // Thread channel allocation for MariaDB
  let threadAllocator = new ThreadPageAllocator(MAX_PAGES);

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 12, dataBufferSize: 65536, useSharedMemory: true },
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

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
          skipKernelCreate: true,
        });

        const programBytes = pidProgram.get(parentPid)!;
        pidProgram.set(childPid, programBytes);

        const ASYNCIFY_BUF_SIZE = 16384;
        const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes,
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
          pidProgram.delete(childPid);
        });

        return [childChannelOffset];
      },

      onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, ctidPtr, memory) => {
        const alloc = threadAllocator.allocate(memory);

        kernelWorker.addChannel(pid, alloc.channelOffset, tid);

        const threadInitData: CentralizedThreadInitMessage = {
          type: "centralized_thread_init",
          pid,
          tid,
          programBytes: mysqldBytes,
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

      onExit: (pid, exitStatus) => {
        console.log(`[kernel] process ${pid} exited with status ${exitStatus}`);
        // Master processes: fully unregister
        if (pid === 1 || pid === 3 || pid === 5) {
          kernelWorker.unregisterProcess(pid);
        } else {
          kernelWorker.deactivateProcess(pid);
        }
        workers.delete(pid);
        pidProgram.delete(pid);
      },
    },
  );

  await kernelWorker.init(kernelBytes);

  // =========================================================================
  // Phase 1: MariaDB (pid 1)
  // =========================================================================

  const dbPid = 1;
  const db = createProcessMemory();
  kernelWorker.registerProcess(dbPid, db.memory, [db.channelOffset]);
  kernelWorker.setCwd(dbPid, dataDir);
  kernelWorker.setNextChildPid(2);
  pidProgram.set(dbPid, mysqldBytes);

  // Check if bootstrap is needed
  const mysqlDir = resolve(dataDir, "mysql");
  const needsBootstrap = readdirSync(mysqlDir).length === 0;

  if (needsBootstrap) {
    console.log("Bootstrapping MariaDB system tables...");
    const shareDir = resolve(mariadbInstall, "share/mysql");
    const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
    const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
    kernelWorker.setStdinData(dbPid, new TextEncoder().encode(bootstrapSql));

    const bootstrapInit: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: dbPid,
      ppid: 0,
      programBytes: mysqldBytes,
      memory: db.memory,
      channelOffset: db.channelOffset,
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      argv: [
        "mariadbd", "--no-defaults",
        `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
        "--default-storage-engine=Aria", "--skip-grant-tables",
        "--key-buffer-size=1048576", "--table-open-cache=10",
        "--sort-buffer-size=262144", "--bootstrap", "--log-warnings=0",
      ],
    };

    const bootstrapWorker = workerAdapter.createWorker(bootstrapInit);
    workers.set(dbPid, bootstrapWorker);

    // Wait for bootstrap to complete (with timeout)
    await new Promise<void>((resolveP) => {
      const timeout = setTimeout(() => {
        console.log("Bootstrap complete (timeout). Proceeding...");
        resolveP();
      }, 30000);

      bootstrapWorker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exit") {
          clearTimeout(timeout);
          resolveP();
        }
      });
    });

    await bootstrapWorker.terminate().catch(() => {});
    workers.delete(dbPid);
    kernelWorker.unregisterProcess(dbPid);

    // Create WordPress database
    console.log("Creating wordpress database...");
    const db2 = createProcessMemory();
    kernelWorker.registerProcess(dbPid, db2.memory, [db2.channelOffset]);
    kernelWorker.setCwd(dbPid, dataDir);
    kernelWorker.setNextChildPid(2);
    kernelWorker.setStdinData(dbPid, new TextEncoder().encode("CREATE DATABASE IF NOT EXISTS wordpress;\n"));

    const createDbInit: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid: dbPid,
      ppid: 0,
      programBytes: mysqldBytes,
      memory: db2.memory,
      channelOffset: db2.channelOffset,
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      argv: [
        "mariadbd", "--no-defaults",
        `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
        "--default-storage-engine=Aria", "--skip-grant-tables",
        "--key-buffer-size=1048576", "--table-open-cache=10",
        "--sort-buffer-size=262144", "--bootstrap", "--log-warnings=0",
      ],
    };

    const createDbWorker = workerAdapter.createWorker(createDbInit);
    workers.set(dbPid, createDbWorker);

    await new Promise<void>((resolveP) => {
      const timeout = setTimeout(() => resolveP(), 15000);
      createDbWorker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exit") { clearTimeout(timeout); resolveP(); }
      });
    });

    await createDbWorker.terminate().catch(() => {});
    workers.delete(dbPid);
    kernelWorker.unregisterProcess(dbPid);
    console.log("Database bootstrap complete.\n");
  }

  // Start MariaDB server
  console.log("Starting MariaDB on 127.0.0.1:3306...");
  const dbServer = createProcessMemory();
  // Reset thread channel allocation for fresh server
  threadAllocator = new ThreadPageAllocator(MAX_PAGES);
  kernelWorker.registerProcess(dbPid, dbServer.memory, [dbServer.channelOffset]);
  kernelWorker.setCwd(dbPid, dataDir);
  kernelWorker.setNextChildPid(2);
  pidProgram.set(dbPid, mysqldBytes);

  const dbServerInit: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: dbPid,
    ppid: 0,
    programBytes: mysqldBytes,
    memory: dbServer.memory,
    channelOffset: dbServer.channelOffset,
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    argv: [
      "mariadbd", "--no-defaults",
      `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
      "--default-storage-engine=Aria", "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--skip-networking=0", "--port=3306",
      "--bind-address=0.0.0.0", "--socket=",
      "--max-connections=10",
    ],
  };

  const dbWorker = workerAdapter.createWorker(dbServerInit);
  workers.set(dbPid, dbWorker);
  dbWorker.on("error", (err: Error) => {
    console.error(`MariaDB error: ${err.message}`);
  });

  // Wait for MariaDB to be ready
  console.log("Waiting for MariaDB to initialize...");
  await new Promise((r) => setTimeout(r, 5000));

  // =========================================================================
  // Phase 2: PHP-FPM (pid 3)
  // =========================================================================

  const fpmPid = 3;
  const fpm = createProcessMemory();
  kernelWorker.registerProcess(fpmPid, fpm.memory, [fpm.channelOffset]);
  kernelWorker.setCwd(fpmPid, wpDir);
  pidProgram.set(fpmPid, phpFpmBytes);

  const fpmInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: fpmPid,
    ppid: 0,
    programBytes: phpFpmBytes,
    memory: fpm.memory,
    channelOffset: fpm.channelOffset,
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    argv: ["php-fpm", "-y", phpFpmConf, "-c", "/dev/null", "--nodaemonize"],
  };

  console.log("Starting PHP-FPM (pid 3) on 127.0.0.1:9000...");
  const fpmWorker = workerAdapter.createWorker(fpmInitData);
  workers.set(fpmPid, fpmWorker);
  fpmWorker.on("error", (err: Error) => {
    console.error(`PHP-FPM error: ${err.message}`);
  });

  // Wait for PHP-FPM to start listening
  console.log("Waiting for PHP-FPM to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // =========================================================================
  // Phase 3: nginx (pid 5)
  // =========================================================================

  const nginxPid = 5;
  const ngx = createProcessMemory();
  kernelWorker.registerProcess(nginxPid, ngx.memory, [ngx.channelOffset]);
  kernelWorker.setCwd(nginxPid, scriptDir);
  pidProgram.set(nginxPid, nginxBytes);

  const confPath = generateNginxConf();
  const nginxInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: nginxPid,
    ppid: 0,
    programBytes: nginxBytes,
    memory: ngx.memory,
    channelOffset: ngx.channelOffset,
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    argv: ["nginx", "-p", scriptDir + "/", "-c", confPath],
  };

  console.log(`Starting nginx (pid 5) on http://localhost:${port}/...`);
  console.log("  nginx will fork 2 worker processes\n");
  const nginxWorker = workerAdapter.createWorker(nginxInitData);
  workers.set(nginxPid, nginxWorker);
  nginxWorker.on("error", (err: Error) => {
    console.error(`nginx error: ${err.message}`);
  });

  // =========================================================================
  // Ready
  // =========================================================================

  console.log("=== LAMP stack running on wasm-posix-kernel ===");
  console.log(`  MariaDB:   127.0.0.1:3306 (pid 1)`);
  console.log(`  PHP-FPM:   127.0.0.1:9000 (pid 3 + worker)`);
  console.log(`  nginx:     http://localhost:${port}/ (pid 5 + 2 workers)`);
  console.log(`  WordPress: http://localhost:${port}/`);
  console.log("\nPress Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    for (const [, w] of workers) {
      await w.terminate().catch(() => {});
    }
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
