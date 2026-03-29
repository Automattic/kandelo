/**
 * serve-php.ts — Run nginx + php-fpm on wasm-posix-kernel.
 *
 * Starts two Wasm processes in the same kernel:
 *   - php-fpm (pid 1) listening on 127.0.0.1:9000
 *   - nginx   (pid 3) listening on 0.0.0.0:8080, proxying .php to fpm
 *
 * The kernel's cross-process loopback routes nginx → php-fpm traffic
 * through in-kernel pipes.
 *
 * Usage:
 *   npx tsx examples/nginx/serve-php.ts
 *
 * Then: curl http://localhost:8080/info.php
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol";

const CH_TOTAL_SIZE = 40 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();
const prefix = resolve(scriptDir);

// Create temp directories
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

async function main() {
  const phpFpmWasm = resolve(scriptDir, "php-fpm.wasm");
  const nginxWasm = resolve(scriptDir, "nginx.wasm");
  const confPath = resolve(scriptDir, "nginx.conf");
  const phpFpmConf = resolve(scriptDir, "php-fpm.conf");

  for (const [name, path] of [["php-fpm.wasm", phpFpmWasm], ["nginx.wasm", nginxWasm]] as const) {
    if (!existsSync(path)) {
      console.error(`${name} not found. Run the appropriate build script first.`);
      process.exit(1);
    }
  }

  const kernelBytes = loadBytes(resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm"));
  const phpFpmBytes = loadBytes(phpFpmWasm);
  const nginxBytes = loadBytes(nginxWasm);

  const io = new NodePlatformIO();
  const workers = new Map<number, ReturnType<NodeWorkerAdapter["createWorker"]>>();

  const kernelWorker = new CentralizedKernelWorker(
    { maxWorkers: 8, dataBufferSize: 65536, useSharedMemory: true },
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

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], {
          skipKernelCreate: true,
        });

        // Determine which program this fork belongs to
        const parentWorker = workers.get(parentPid);
        // Use the parent's program bytes for fork children
        const programBytes = parentPid === 1 ? phpFpmBytes : nginxBytes;

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
      },
    },
  );

  await kernelWorker.init(kernelBytes);

  // Test: try calling kernel_connect to verify debug logging works
  const kernelInst = kernelWorker.getKernel().getInstance();
  if (kernelInst) {
    const exports = kernelInst.exports;
    console.log("Kernel exports:", Object.keys(exports).filter(k => k.includes("connect") || k.includes("debug")).join(", "));
  }

  // --- Process 1: php-fpm ---
  const fpmPid = 1;
  const fpm = createProcessMemory();
  kernelWorker.registerProcess(fpmPid, fpm.memory, [fpm.channelOffset]);
  kernelWorker.setCwd(fpmPid, prefix);
  kernelWorker.setNextChildPid(2);

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

  console.log("Starting php-fpm (pid 1) on 127.0.0.1:9000...");
  const fpmWorker = workerAdapter.createWorker(fpmInitData);
  workers.set(fpmPid, fpmWorker);
  fpmWorker.on("error", (err: Error) => {
    console.error(`php-fpm error: ${err.message}`);
  });

  // Wait for php-fpm to start listening before starting nginx
  console.log("Waiting for php-fpm to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // --- Process 3: nginx ---
  // (pid 2 is reserved for php-fpm's fork child)
  const nginxPid = 3;
  const ngx = createProcessMemory();
  kernelWorker.registerProcess(nginxPid, ngx.memory, [ngx.channelOffset]);
  kernelWorker.setCwd(nginxPid, prefix);

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
      "-p", prefix + "/",
      "-c", confPath,
    ],
  };

  console.log("Starting nginx (pid 3) on http://localhost:8080/...");
  const nginxWorker = workerAdapter.createWorker(nginxInitData);
  workers.set(nginxPid, nginxWorker);
  nginxWorker.on("error", (err: Error) => {
    console.error(`nginx error: ${err.message}`);
  });

  console.log("\nnginx + php-fpm running!");
  console.log("  Static files: curl http://localhost:8080/");
  console.log("  PHP:          curl http://localhost:8080/info.php");
  console.log("\nPress Ctrl+C to stop.");

  // Handle Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    for (const [pid, w] of workers) {
      await w.terminate().catch(() => {});
    }
    process.exit(0);
  });

  // Wait forever
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
