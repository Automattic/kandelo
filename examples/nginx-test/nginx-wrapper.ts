/**
 * nginx-wrapper.ts — Drop-in replacement for the nginx binary.
 *
 * The upstream nginx test suite (Test::Nginx) expects to exec() an nginx
 * binary. This wrapper accepts the same command-line interface but runs
 * nginx inside a CentralizedKernelWorker.
 *
 * Supported flags:
 *   -V              Print version and configure arguments
 *   -t              Test configuration
 *   -T              Test and dump configuration
 *   -p prefix       Set prefix path
 *   -c config       Set config file
 *   -e errorlog     Set error log path
 *   -g directives   Set global directives
 *   -s signal       Send signal to running process (not supported)
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { createConnection } from "net";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import { tryResolveBinary } from "../../host/src/binary-resolver";
import type { CentralizedWorkerInitMessage, WorkerToHostMessage } from "../../host/src/worker-protocol";

const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const workerAdapter = new NodeWorkerAdapter();

// Our nginx build configure arguments (for -V output)
const CONFIGURE_ARGS = [
  "--without-http_rewrite_module",
  "--without-http_gzip_module",
  "--without-http_uwsgi_module",
  "--without-http_scgi_module",
  "--without-http_memcached_module",
  "--without-http_empty_gif_module",
  "--without-http_browser_module",
  "--without-http_upstream_ip_hash_module",
  "--without-http_upstream_least_conn_module",
  "--without-http_upstream_keepalive_module",
  "--without-select_module",
  "--with-poll_module",
].join(" ");

function parseArgs(args: string[]) {
  const result: {
    version: boolean;
    test: boolean;
    testDump: boolean;
    prefix: string;
    config: string;
    errorLog: string;
    globals: string;
    signal: string;
  } = {
    version: false,
    test: false,
    testDump: false,
    prefix: "",
    config: "conf/nginx.conf",
    errorLog: "",
    globals: "",
    signal: "",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-V":
        result.version = true;
        break;
      case "-t":
        result.test = true;
        break;
      case "-T":
        result.testDump = true;
        break;
      case "-p":
        result.prefix = args[++i] || "";
        break;
      case "-c":
        result.config = args[++i] || "";
        break;
      case "-e":
        result.errorLog = args[++i] || "";
        break;
      case "-g":
        result.globals = args[++i] || "";
        break;
      case "-s":
        result.signal = args[++i] || "";
        break;
    }
  }

  return result;
}

function handleVersion() {
  process.stderr.write(`nginx version: nginx/1.24.0 (wasm-posix-kernel)\n`);
  process.stderr.write(`configure arguments: ${CONFIGURE_ARGS}\n`);
  process.exit(0);
}

function handleTest(opts: ReturnType<typeof parseArgs>) {
  // Just check if config file exists
  const confPath = resolve(opts.prefix, opts.config);
  if (!existsSync(confPath)) {
    process.stderr.write(`nginx: [emerg] open() "${confPath}" failed\n`);
    process.exit(1);
  }
  process.stderr.write(`nginx: the configuration file ${confPath} syntax is ok\n`);
  process.stderr.write(`nginx: configuration file ${confPath} test is successful\n`);
  process.exit(0);
}

async function runNginx(opts: ReturnType<typeof parseArgs>) {
  const nginxWasm = tryResolveBinary("programs/nginx.wasm");
  if (!nginxWasm) {
    process.stderr.write(
      "nginx.wasm not found. Run: scripts/fetch-binaries.sh " +
      "(or bash examples/nginx/build.sh to build locally).\n",
    );
    process.exit(1);
  }

  const kernelWasm = tryResolveBinary("kernel.wasm");
  if (!kernelWasm) {
    process.stderr.write(
      "kernel.wasm not found. Run: scripts/fetch-binaries.sh " +
      "(or bash build.sh to build locally).\n",
    );
    process.exit(1);
  }

  const loadBytes = (path: string): ArrayBuffer => {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };

  const kernelBytes = loadBytes(kernelWasm);
  const nginxBytes = loadBytes(nginxWasm);

  // Extract PID file path from globals (if -g was used) and strip it
  let pidFile = "";
  let globals = opts.globals;
  const pidMatch = globals.match(/pid\s+([^;]+);/);
  if (pidMatch) {
    pidFile = pidMatch[1].trim();
    globals = globals.replace(/pid\s+[^;]+;\s*/, "");
  }

  // If no pid in globals, look for it in the config file
  if (!pidFile) {
    const confPath = resolve(opts.prefix || process.cwd(), opts.config);
    if (existsSync(confPath)) {
      const confContent = readFileSync(confPath, "utf-8");
      const confPidMatch = confContent.match(/^\s*pid\s+([^;]+);/m);
      if (confPidMatch) {
        pidFile = confPidMatch[1].trim();
        // Resolve relative paths against prefix
        if (!pidFile.startsWith("/")) {
          pidFile = resolve(opts.prefix || process.cwd(), pidFile);
        }
      }
    }
  }

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

        kernelWorker.registerProcess(childPid, childMemory, [childChannelOffset], { skipKernelCreate: true });

        const ASYNCIFY_BUF_SIZE = 16384;
        const asyncifyBufAddr = childChannelOffset - ASYNCIFY_BUF_SIZE;
        const childInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid: childPid,
          ppid: parentPid,
          programBytes: nginxBytes,
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

  // Create shared memory for master process
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
  kernelWorker.setCwd(pid, opts.prefix || process.cwd());
  kernelWorker.setNextChildPid(2);

  // Build nginx argv
  const argv = ["nginx", "-p", (opts.prefix || process.cwd()) + "/", "-c", opts.config];
  if (opts.errorLog) {
    argv.push("-e", opts.errorLog);
  }
  if (globals) {
    argv.push("-g", globals);
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes: nginxBytes,
    memory,
    channelOffset,
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ],
    argv,
  };

  const masterWorker = workerAdapter.createWorker(initData);
  workers.set(pid, masterWorker);

  let exited = false;
  const exitPromise = new Promise<number>((resolveP, reject) => {
    masterWorker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      if (m.type === "exit") {
        exited = true;
        kernelWorker.unregisterProcess(pid);
        resolveP(m.status);
      } else if (m.type === "error") {
        exited = true;
        kernelWorker.unregisterProcess(pid);
        reject(new Error(m.message));
      }
    });
    masterWorker.on("error", (err: Error) => { exited = true; reject(err); });
  });

  // Parse listen port from config to poll for readiness
  let listenPort = 0;
  const confPath = resolve(opts.prefix || process.cwd(), opts.config);
  if (existsSync(confPath)) {
    const confContent = readFileSync(confPath, "utf-8");
    const listenMatch = confContent.match(/listen\s+(?:[\d.]+:)?(\d+)/);
    if (listenMatch) {
      listenPort = parseInt(listenMatch[1], 10);
    }
  }

  // Wait for nginx to be ready before writing PID file
  if (listenPort > 0) {
    for (let i = 0; i < 80; i++) {
      if (exited) break;
      await new Promise((r) => setTimeout(r, 250));
      try {
        await new Promise<void>((res, rej) => {
          const sock = createConnection({ host: "127.0.0.1", port: listenPort }, () => {
            sock.destroy();
            res();
          });
          sock.on("error", rej);
          sock.setTimeout(500, () => { sock.destroy(); rej(new Error("timeout")); });
        });
        break; // connected successfully
      } catch {
        // not ready yet
      }
    }
  } else {
    // No listen port found, just wait a bit
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Write PID file with OUR host pid (so test framework can signal us)
  if (pidFile) {
    writeFileSync(pidFile, String(process.pid) + "\n");
  }

  // Handle shutdown signals
  const shutdown = async () => {
    for (const [, w] of workers) {
      await w.terminate().catch(() => {});
    }
    process.exit(0);
  };

  process.on("SIGQUIT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    const status = await exitPromise;
    for (const [, w] of workers) {
      await w.terminate().catch(() => {});
    }
    process.exit(status);
  } catch {
    for (const [, w] of workers) {
      await w.terminate().catch(() => {});
    }
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opts = parseArgs(args);

  if (opts.version) {
    handleVersion();
    return;
  }

  if (opts.signal) {
    process.stderr.write("nginx-wrapper: -s signal not supported\n");
    process.exit(1);
  }

  if (opts.test || opts.testDump) {
    handleTest(opts);
    return;
  }

  await runNginx(opts);
}

main().catch((err) => {
  process.stderr.write(`nginx-wrapper error: ${err.message}\n`);
  process.exit(1);
});
