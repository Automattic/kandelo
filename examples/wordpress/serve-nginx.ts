/**
 * serve-nginx.ts — WordPress behind nginx + PHP-FPM on wasm-posix-kernel.
 *
 * Starts multiple Wasm processes in the same kernel:
 *   - php-fpm master (pid 1) → forks 1 worker (pid 2)
 *   - nginx master   (pid 3) → forks 2 workers (pid 4, 5)
 *
 * nginx handles HTTP connections (multi-worker) and proxies all requests
 * to PHP-FPM via FastCGI over the kernel's loopback TCP. A PHP router
 * script serves static files and routes WordPress requests.
 *
 * Usage:
 *   npx tsx examples/wordpress/serve-nginx.ts [port]
 *
 * Requires:
 *   1. nginx binary:   examples/nginx/nginx.wasm
 *      (build with: bash examples/nginx/build.sh)
 *   2. PHP-FPM binary: examples/nginx/php-fpm.wasm
 *      (build with: bash examples/nginx/build-php-fpm.sh)
 *   3. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import type {
  CentralizedWorkerInitMessage,
} from "../../host/src/worker-protocol";

const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

const nginxWasmPath = resolve(repoRoot, "examples/nginx/nginx.wasm");
const phpFpmWasmPath = resolve(repoRoot, "examples/nginx/php-fpm.wasm");
const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
const wpDir = resolve(scriptDir, "wordpress");
const confTemplate = resolve(scriptDir, "nginx.conf");
const phpFpmConf = resolve(scriptDir, "php-fpm.conf");
const routerScript = resolve(scriptDir, "fpm-router.php");

const port = parseInt(process.argv[2] || "8080", 10);

// Validate prerequisites
for (const [name, path, hint] of [
  ["nginx.wasm", nginxWasmPath, "bash examples/nginx/build.sh"],
  ["php-fpm.wasm", phpFpmWasmPath, "bash examples/nginx/build-php-fpm.sh"],
  ["kernel wasm", kernelWasmPath, "bash build.sh"],
] as const) {
  if (!existsSync(path)) {
    console.error(`Error: ${name} not found. Run: ${hint}`);
    process.exit(1);
  }
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash examples/wordpress/setup.sh");
  process.exit(1);
}

// Create temp directories nginx needs
for (const dir of ["client_body_temp", "fastcgi_temp"]) {
  mkdirSync(join("/tmp/nginx-wasm", dir), { recursive: true });
}
mkdirSync("/tmp/nginx-wasm/logs", { recursive: true });

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

/**
 * Generate nginx.conf with the WordPress root path and port substituted.
 * Returns the path to the generated config file.
 */
function generateNginxConf(): string {
  let conf = readFileSync(confTemplate, "utf-8");
  conf = conf.replace(/WORDPRESS_ROOT/g, wpDir);
  conf = conf.replace(/ROUTER_SCRIPT/g, routerScript);
  conf = conf.replace("listen 8080", `listen ${port}`);
  const outPath = "/tmp/nginx-wasm/wordpress-nginx.conf";
  writeFileSync(outPath, conf);
  return outPath;
}

async function main() {
  const kernelBytes = loadBytes(kernelWasmPath);
  const phpFpmBytes = loadBytes(phpFpmWasmPath);
  const nginxBytes = loadBytes(nginxWasmPath);

  const io = new NodePlatformIO();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();
  const pidProgram = new Map<number, ArrayBuffer>();

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

      onExec: async () => -38, // ENOSYS

      onExit: (pid, exitStatus) => {
        console.log(`[kernel] process ${pid} exited with status ${exitStatus}`);
        if (pid === 1 || pid === 3) {
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

  // --- Process 1: php-fpm master ---
  const fpmPid = 1;
  const fpm = createProcessMemory();
  kernelWorker.registerProcess(fpmPid, fpm.memory, [fpm.channelOffset]);
  kernelWorker.setCwd(fpmPid, wpDir);
  kernelWorker.setNextChildPid(2);
  pidProgram.set(fpmPid, phpFpmBytes);

  const fpmInitData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid: fpmPid,
    ppid: 0,
    programBytes: phpFpmBytes,
    memory: fpm.memory,
    channelOffset: fpm.channelOffset,
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ],
    argv: [
      "php-fpm",
      "-y", phpFpmConf,
      "-c", "/dev/null",
      "--nodaemonize",
    ],
  };

  console.log("Starting php-fpm master (pid 1) on 127.0.0.1:9000...");
  const fpmWorker = workerAdapter.createWorker(fpmInitData);
  workers.set(fpmPid, fpmWorker);
  fpmWorker.on("error", (err: Error) => {
    console.error(`php-fpm error: ${err.message}`);
  });

  // Wait for php-fpm to start listening before starting nginx
  console.log("Waiting for php-fpm to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // --- Process 3: nginx master ---
  // (pid 2 is reserved for php-fpm's fork child)
  const nginxPid = 3;
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
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ],
    argv: [
      "nginx",
      "-p", scriptDir + "/",
      "-c", confPath,
    ],
  };

  console.log(`Starting nginx master (pid 3) on http://localhost:${port}/...`);
  console.log("  nginx will fork 2 worker processes");
  const nginxWorker = workerAdapter.createWorker(nginxInitData);
  workers.set(nginxPid, nginxWorker);
  nginxWorker.on("error", (err: Error) => {
    console.error(`nginx error: ${err.message}`);
  });

  console.log("\nWordPress running behind nginx + php-fpm!");
  console.log(`  Homepage:  curl http://localhost:${port}/`);
  console.log(`  Admin:     http://localhost:${port}/wp-admin/`);
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
