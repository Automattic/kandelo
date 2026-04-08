/**
 * serve.ts — Run dash shell on the wasm-posix-kernel.
 *
 * Supports three modes:
 *   1. Command: npx tsx examples/shell/serve.ts -c "echo hello"
 *   2. Piped:   echo "echo hello" | npx tsx examples/shell/serve.ts
 *   3. Script:  npx tsx examples/shell/serve.ts script.sh
 *
 * Build dash first:
 *   bash examples/libs/dash/build-dash.sh
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { NodePlatformIO } from "../../host/src/platform/node";
import { NodeWorkerAdapter } from "../../host/src/worker-adapter";
import type {
  CentralizedWorkerInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol";
import { ThreadPageAllocator } from "../../host/src/thread-allocator";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Read all of stdin (for piped mode). */
function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

async function main() {
  const dashBinPath = resolve(repoRoot, "examples/libs/dash/bin/dash.wasm");
  const dashSrcPath = resolve(repoRoot, "examples/libs/dash/dash-src/src/dash");
  const dashBinary = existsSync(dashBinPath) ? dashBinPath : dashSrcPath;
  if (!existsSync(dashBinary)) {
    console.error(
      "dash binary not found. Run: bash examples/libs/dash/build-dash.sh",
    );
    process.exit(1);
  }

  const kernelWasmPath = resolve(repoRoot, "host/wasm/wasm_posix_kernel.wasm");
  if (!existsSync(kernelWasmPath)) {
    console.error("Kernel wasm not found. Run: bash build.sh");
    process.exit(1);
  }

  // Parse args: everything after serve.ts goes to dash
  const args = process.argv.slice(2);
  const dashArgv = ["dash", ...args];

  // Read piped stdin if available
  const stdinData = await readStdin();

  const kernelBytes = loadBytes(kernelWasmPath);
  const programBytes = loadBytes(dashBinary);

  // --- Load external programs for exec ---
  // Maps virtual filesystem paths to wasm binary bytes.
  const execPrograms = new Map<string, ArrayBuffer>();

  // Load coreutils single binary (if built)
  const coreutilsBinary = resolve(
    repoRoot,
    "examples/libs/coreutils/bin/coreutils.wasm",
  );
  if (existsSync(coreutilsBinary)) {
    const coreutilsBytes = loadBytes(coreutilsBinary);
    // The coreutils single binary uses argv[0] to determine which utility to run.
    // Register it under all standard utility names.
    const coreutilsNames = [
      "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
      "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
      "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
      "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
      "fold", "groups", "head", "hostid", "id", "install", "join", "link",
      "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
      "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
      "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
      "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
      "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
      "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
      "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
      "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
      "yes",
    ];
    for (const name of coreutilsNames) {
      execPrograms.set(`/bin/${name}`, coreutilsBytes);
      execPrograms.set(`/usr/bin/${name}`, coreutilsBytes);
    }
    // Also register [  (test alias)
    execPrograms.set("/bin/[", coreutilsBytes);
    execPrograms.set("/usr/bin/[", coreutilsBytes);
    console.error(`Loaded ${coreutilsNames.length} coreutils commands`);
  }

  // Load GNU grep (if built)
  const grepBinary = resolve(
    repoRoot,
    "examples/libs/grep/bin/grep.wasm",
  );
  if (existsSync(grepBinary)) {
    const grepBytes = loadBytes(grepBinary);
    execPrograms.set("/bin/grep", grepBytes);
    execPrograms.set("/usr/bin/grep", grepBytes);
    // Also register egrep and fgrep (grep invokes itself differently based on argv[0])
    execPrograms.set("/bin/egrep", grepBytes);
    execPrograms.set("/usr/bin/egrep", grepBytes);
    execPrograms.set("/bin/fgrep", grepBytes);
    execPrograms.set("/usr/bin/fgrep", grepBytes);
    console.error("Loaded GNU grep");
  }

  // Load GNU sed (if built)
  const sedBinary = resolve(
    repoRoot,
    "examples/libs/sed/bin/sed.wasm",
  );
  if (existsSync(sedBinary)) {
    const sedBytes = loadBytes(sedBinary);
    execPrograms.set("/bin/sed", sedBytes);
    execPrograms.set("/usr/bin/sed", sedBytes);
    console.error("Loaded GNU sed");
  }

  // Load dash as /bin/sh
  execPrograms.set("/bin/sh", programBytes);
  execPrograms.set("/bin/dash", programBytes);

  const io = new NodePlatformIO();
  const workerAdapter = new NodeWorkerAdapter();
  const workers = new Map<
    number,
    ReturnType<NodeWorkerAdapter["createWorker"]>
  >();

  let resolveExit: (status: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const threadAllocator = new ThreadPageAllocator(MAX_PAGES);

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
        new Uint8Array(
          childMemory.buffer,
          childChannelOffset,
          CH_TOTAL_SIZE,
        ).fill(0);

        kernelWorker.registerProcess(childPid, childMemory, [
          childChannelOffset,
        ], { skipKernelCreate: true });

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
      onExec: async (pid, path, argv, envp) => {
        // Resolve the path to a wasm binary
        let wasmBytes: ArrayBuffer | undefined;

        if (path.startsWith("/")) {
          // Absolute path — look up directly
          wasmBytes = execPrograms.get(path);
        } else {
          // Bare command — search PATH
          const pathEnv = envp.find(e => e.startsWith("PATH="))?.slice(5)
            ?? "/usr/local/bin:/usr/bin:/bin";
          for (const dir of pathEnv.split(":")) {
            const full = `${dir}/${path}`;
            wasmBytes = execPrograms.get(full);
            if (wasmBytes) break;
          }
        }

        if (!wasmBytes) return -2; // ENOENT

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

        // Re-register process with fresh memory
        kernelWorker.registerProcess(pid, newMemory, [newChannelOffset], { skipKernelCreate: true });

        // Create new worker with the exec'd program
        const execInitData: CentralizedWorkerInitMessage = {
          type: "centralized_init",
          pid,
          ppid: 0,
          programBytes: wasmBytes,
          memory: newMemory,
          channelOffset: newChannelOffset,
          argv,
          env: envp,
        };

        const newWorker = workerAdapter.createWorker(execInitData);
        workers.set(pid, newWorker);
        newWorker.on("error", () => {
          kernelWorker.unregisterProcess(pid);
          workers.delete(pid);
        });

        return 0;
      },
      onClone: async (
        pid,
        tid,
        _fnPtr,
        _argPtr,
        _stackPtr,
        _tlsPtr,
        _ctidPtr,
        memory,
      ) => {
        const alloc = threadAllocator.allocate(memory);

        kernelWorker.addChannel(pid, alloc.channelOffset, tid);

        const threadInitData = {
          type: "centralized_thread_init" as const,
          pid,
          tid,
          programBytes,
          memory,
          channelOffset: alloc.channelOffset,
          fnPtr: _fnPtr,
          argPtr: _argPtr,
          stackPtr: _stackPtr,
          tlsPtr: _tlsPtr,
          ctidPtr: _ctidPtr,
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
        threadWorker.on("error", () => {
          kernelWorker.notifyThreadExit(pid, tid);
          kernelWorker.removeChannel(pid, alloc.channelOffset);
          threadAllocator.free(alloc.basePage);
        });

        return tid;
      },
      onExit: (pid, exitStatus) => {
        if (pid === 1) {
          kernelWorker.unregisterProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
          resolveExit(exitStatus);
        } else {
          kernelWorker.deactivateProcess(pid);
          const w = workers.get(pid);
          if (w) {
            w.terminate().catch(() => {});
            workers.delete(pid);
          }
        }
      },
    },
  );

  // Forward stdout/stderr to host
  kernelWorker.setOutputCallbacks({
    onStdout: (data: Uint8Array) => {
      process.stdout.write(data);
    },
    onStderr: (data: Uint8Array) => {
      process.stderr.write(data);
    },
  });

  await kernelWorker.init(kernelBytes);

  // Create process memory
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
  kernelWorker.setCwd(pid, "/");

  // Provide piped stdin data if available
  if (stdinData.length > 0) {
    kernelWorker.setStdinData(pid, new Uint8Array(stdinData));
  }

  const initData: CentralizedWorkerInitMessage = {
    type: "centralized_init",
    pid,
    ppid: 0,
    programBytes,
    memory,
    channelOffset,
    env: [
      "HOME=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TMPDIR=/tmp",
      "TERM=dumb",
    ],
    argv: dashArgv,
  };

  const mainWorker = workerAdapter.createWorker(initData);
  workers.set(pid, mainWorker);

  mainWorker.on("error", (err: Error) => {
    console.error("Worker error:", err);
    process.exit(1);
  });

  const exitCode = await exitPromise;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
