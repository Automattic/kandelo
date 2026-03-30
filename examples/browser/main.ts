import { CentralizedKernelWorker } from "../../host/src/kernel-worker";
import { BrowserWorkerAdapter } from "../../host/src/worker-adapter-browser";
import { VirtualPlatformIO } from "../../host/src/vfs/vfs";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { DeviceFileSystem } from "../../host/src/vfs/device-fs";
import { BrowserTimeProvider } from "../../host/src/vfs/time";
import type {
  CentralizedWorkerInitMessage,
  CentralizedThreadInitMessage,
  WorkerToHostMessage,
} from "../../host/src/worker-protocol";
import kernelWasmUrl from "../../host/wasm/wasm_posix_kernel.wasm?url";
import workerEntryUrl from "../../host/src/worker-entry-browser.ts?worker&url";

const MAX_PAGES = 16384;
const CH_TOTAL_SIZE = 40 + 65536;

const output = document.getElementById("output") as HTMLPreElement;
const programSelect = document.getElementById("program") as HTMLSelectElement;
const runButton = document.getElementById("run") as HTMLButtonElement;

function appendOutput(text: string, className?: string) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

const decoder = new TextDecoder();

async function run() {
  runButton.disabled = true;
  output.textContent = "";

  const programName = programSelect.value;
  appendOutput(`Loading ${programName}...\n`, "info");

  try {
    // Fetch kernel and program wasm in parallel
    const programWasmUrl = new URL(`../${programName}.wasm`, import.meta.url).href;
    const [kernelBytes, programBytes] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(programWasmUrl).then((r) => r.arrayBuffer()),
    ]);

    // Set up virtual filesystem with /dev mount
    const memfs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
    const devfs = new DeviceFileSystem();
    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/dev", backend: devfs },
        { mountPoint: "/", backend: memfs },
      ],
      new BrowserTimeProvider(),
    );

    memfs.mkdir("/tmp", 0o777);
    memfs.mkdir("/home", 0o755);
    memfs.mkdir("/dev", 0o755);

    // Worker adapter for browser Web Workers
    const workerAdapter = new BrowserWorkerAdapter(workerEntryUrl);

    // Promise for main process exit
    let resolveExit: (status: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    let mainWorker: ReturnType<BrowserWorkerAdapter["createWorker"]> | null = null;

    // Thread channel allocator (counting down from main channel)
    let nextThreadChannelPage = MAX_PAGES - 4;

    const kernelWorker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
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
          childWorker.on("error", () => {
            kernelWorker.unregisterProcess(childPid);
          });

          return [childChannelOffset];
        },
        onExec: async () => -38, // ENOSYS
        onClone: async (pid, tid, fnPtr, argPtr, stackPtr, tlsPtr, _ctidPtr, memory) => {
          const threadChannelOffset = nextThreadChannelPage * 65536;
          const tlsAllocAddr = (nextThreadChannelPage - 2) * 65536;
          nextThreadChannelPage -= 3;
          new Uint8Array(memory.buffer, threadChannelOffset, CH_TOTAL_SIZE).fill(0);
          new Uint8Array(memory.buffer, tlsAllocAddr, 65536).fill(0);

          kernelWorker.addChannel(pid, threadChannelOffset, tid);

          const threadInitData: CentralizedThreadInitMessage = {
            type: "centralized_thread_init",
            pid,
            tid,
            programBytes,
            memory,
            channelOffset: threadChannelOffset,
            fnPtr,
            argPtr,
            stackPtr,
            tlsPtr,
            ctidPtr: _ctidPtr,
            tlsAllocAddr,
          };

          const threadWorker = workerAdapter.createWorker(threadInitData);
          threadWorker.on("message", (msg: unknown) => {
            const m = msg as WorkerToHostMessage;
            if (m.type === "thread_exit") {
              threadWorker.terminate().catch(() => {});
            }
          });
          threadWorker.on("error", () => {
            kernelWorker.notifyThreadExit(pid, tid);
            kernelWorker.removeChannel(pid, threadChannelOffset);
          });

          return tid;
        },
        onExit: (pid, exitStatus) => {
          if (pid === 1) {
            kernelWorker.unregisterProcess(pid);
            if (mainWorker) mainWorker.terminate().catch(() => {});
            resolveExit(exitStatus);
          } else {
            kernelWorker.deactivateProcess(pid);
          }
        },
      },
    );

    // Inject stdout/stderr callbacks
    const existingCallbacks = (kernelWorker as any).kernel.callbacks || {};
    (kernelWorker as any).kernel.callbacks = {
      ...existingCallbacks,
      onStdout: (data: Uint8Array) => appendOutput(decoder.decode(data)),
      onStderr: (data: Uint8Array) => appendOutput(decoder.decode(data), "stderr"),
    };

    await kernelWorker.init(kernelBytes);

    appendOutput(`Running ${programName}...\n\n`, "info");

    // Create shared memory for the process
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

    const initData: CentralizedWorkerInitMessage = {
      type: "centralized_init",
      pid,
      ppid: 0,
      programBytes,
      memory,
      channelOffset,
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=browser",
      ],
      argv: [programName],
    };

    mainWorker = workerAdapter.createWorker(initData);

    mainWorker.on("error", (err: Error) => {
      appendOutput(`\nWorker error: ${err.message}\n`, "stderr");
    });

    const exitCode = await exitPromise;
    appendOutput(`\nExited with code ${exitCode}\n`, "info");
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    console.error(e);
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", run);
