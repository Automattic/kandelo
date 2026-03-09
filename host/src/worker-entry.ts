// host/src/worker-entry.ts
import { parentPort, workerData } from "node:worker_threads";
import { WasmPosixKernel } from "./kernel";
import { NodePlatformIO } from "./platform/node";
import type {
  WorkerInitMessage,
  WorkerToHostMessage,
  HostToWorkerMessage,
  RegisterPipeMessage,
  ConvertPipeMessage,
} from "./worker-protocol";

interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export async function workerMain(
  port: MessagePort,
  initData: WorkerInitMessage,
): Promise<void> {
  try {
    const kernel = new WasmPosixKernel(initData.kernelConfig, new NodePlatformIO());
    await kernel.init(initData.wasmBytes);

    const instance = kernel.getInstance()!;

    if (initData.forkState) {
      // Fork init: write fork state to Wasm memory and call kernel_init_from_fork
      const memory = kernel.getMemory()!;
      const forkBytes = new Uint8Array(initData.forkState);
      const pages = Math.ceil(forkBytes.byteLength / 65536) + 1;
      const startPage = memory.grow(pages);
      const bufPtr = startPage * 65536;
      new Uint8Array(memory.buffer, bufPtr, forkBytes.byteLength).set(forkBytes);

      const kernelInitFromFork = instance.exports.kernel_init_from_fork as
        (ptr: number, len: number, pid: number) => number;
      const result = kernelInitFromFork(bufPtr, forkBytes.byteLength, initData.pid);
      if (result < 0) {
        throw new Error(`kernel_init_from_fork failed with error ${result}`);
      }
    } else {
      // Fresh init
      const kernelInit = instance.exports.kernel_init as (pid: number) => void;
      kernelInit(initData.pid);
    }

    port.postMessage({
      type: "ready",
      pid: initData.pid,
    } satisfies WorkerToHostMessage);

    // Listen for messages from host
    port.on("message", (msg: unknown) => {
      const m = msg as HostToWorkerMessage;
      switch (m.type) {
        case "terminate":
          port.postMessage({
            type: "exit",
            pid: initData.pid,
            status: 0,
          } satisfies WorkerToHostMessage);
          break;
        case "get_fork_state": {
          const memory = kernel.getMemory()!;
          const FORK_BUF_PAGES = 16; // 1MB buffer
          const startPage = memory.grow(FORK_BUF_PAGES);
          const bufPtr = startPage * 65536;
          const bufSize = FORK_BUF_PAGES * 65536;

          const kernelGetForkState = instance.exports.kernel_get_fork_state as
            (ptr: number, len: number) => number;
          const written = kernelGetForkState(bufPtr, bufSize);
          if (written < 0) {
            port.postMessage({
              type: "error",
              pid: initData.pid,
              message: `kernel_get_fork_state failed: ${written}`,
            } satisfies WorkerToHostMessage);
            break;
          }

          const forkData = new Uint8Array(memory.buffer, bufPtr, written).slice();
          port.postMessage(
            { type: "fork_state", pid: initData.pid, data: forkData.buffer } satisfies WorkerToHostMessage,
            [forkData.buffer],
          );
          break;
        }
        case "register_pipe": {
          const msg = m as RegisterPipeMessage;
          kernel.registerSharedPipe(msg.handle, msg.buffer);
          break;
        }
        case "convert_pipe": {
          const msg = m as ConvertPipeMessage;
          const convertFn = instance.exports.kernel_convert_pipe_to_host as
            (ofdIdx: number, newHandle: bigint) => number;
          const result = convertFn(msg.ofdIndex, BigInt(msg.newHandle));
          if (result < 0) {
            port.postMessage({
              type: "error",
              pid: initData.pid,
              message: `kernel_convert_pipe_to_host failed: ${result}`,
            } satisfies WorkerToHostMessage);
          }
          break;
        }
      }
    });
  } catch (err) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerToHostMessage);
  }
}

// When running as an actual worker thread
if (parentPort) {
  workerMain(parentPort, workerData as WorkerInitMessage);
}
