import { WasmPosixKernel } from "./kernel";
import type { KernelCallbacks } from "./kernel";
import type { PlatformIO } from "./types";
import type {
  WorkerInitMessage,
  WorkerToHostMessage,
  HostToWorkerMessage,
  RegisterPipeMessage,
  ConvertPipeMessage,
  ExecReplyMessage,
} from "./worker-protocol";

export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export type CreateIOFn = (initData: WorkerInitMessage) => PlatformIO;

export async function workerMain(
  port: MessagePort,
  initData: WorkerInitMessage,
  createIO: CreateIOFn,
): Promise<void> {
  try {
    const callbacks: KernelCallbacks = {
      onKill: (pid: number, signal: number): number => {
        port.postMessage({
          type: "kill_request",
          pid,
          signal,
          sourcePid: initData.pid,
        } satisfies WorkerToHostMessage);
        return 0; // fire-and-forget from kernel's perspective
      },
      onExec: (path: string): number => {
        port.postMessage({
          type: "exec_request",
          pid: initData.pid,
          path,
        } satisfies WorkerToHostMessage);
        return 0;
      },
      onAlarm: (seconds: number): number => {
        port.postMessage({
          type: "alarm_set",
          pid: initData.pid,
          seconds,
        } satisfies WorkerToHostMessage);
        return 0;
      },
    };

    let kernel = new WasmPosixKernel(initData.kernelConfig, createIO(initData), callbacks);
    await kernel.init(initData.wasmBytes);

    let instance = kernel.getInstance()!;

    if (initData.signalWakeSab) {
      kernel.registerSignalWakeSab(initData.signalWakeSab);
    }

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

    // Set environment variables and argv if provided
    const needsScratch = (initData.env && initData.env.length > 0)
      || (initData.argv && initData.argv.length > 0);
    let scratchPtr = 0;
    if (needsScratch) {
      const memory = kernel.getMemory()!;
      const scratchPage = memory.grow(1);
      scratchPtr = scratchPage * 65536;
    }
    const encoder = new TextEncoder();

    if (initData.env && initData.env.length > 0) {
      const setenv = instance.exports.kernel_setenv as
        (namePtr: number, nameLen: number, valPtr: number, valLen: number, overwrite: number) => number;
      const memory = kernel.getMemory()!;
      for (const entry of initData.env) {
        const eq = entry.indexOf("=");
        if (eq < 0) continue;
        const nameBytes = encoder.encode(entry.slice(0, eq));
        const valBytes = encoder.encode(entry.slice(eq + 1));
        const buf = new Uint8Array(memory.buffer);
        const valPtr = scratchPtr + nameBytes.length;
        buf.set(nameBytes, scratchPtr);
        buf.set(valBytes, valPtr);
        setenv(scratchPtr, nameBytes.length, valPtr, valBytes.length, 1);
      }
    }

    if (initData.argv && initData.argv.length > 0) {
      const pushArgv = instance.exports.kernel_push_argv as
        (ptr: number, len: number) => void;
      const memory = kernel.getMemory()!;
      for (const arg of initData.argv) {
        const bytes = encoder.encode(arg);
        const buf = new Uint8Array(memory.buffer);
        buf.set(bytes, scratchPtr);
        pushArgv(scratchPtr, bytes.length);
      }
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
          kernel.registerSharedPipe(msg.handle, msg.buffer, msg.end);
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
        case "deliver_signal": {
          const deliverFn = instance.exports.kernel_deliver_signal as
            (sig: number) => number;
          deliverFn(m.signal);
          break;
        }
        case "exec_reply": {
          (async () => {
            try {
              const msg = m as ExecReplyMessage;
              // 1. Get exec state from current kernel
              const memory = kernel.getMemory()!;
              const EXEC_BUF_PAGES = 16; // 1MB buffer
              const startPage = memory.grow(EXEC_BUF_PAGES);
              const bufPtr = startPage * 65536;
              const bufSize = EXEC_BUF_PAGES * 65536;

              const getExecState = instance.exports.kernel_get_exec_state as
                (ptr: number, len: number) => number;
              const written = getExecState(bufPtr, bufSize);
              if (written < 0) {
                port.postMessage({
                  type: "error",
                  pid: initData.pid,
                  message: `kernel_get_exec_state failed: ${written}`,
                } satisfies WorkerToHostMessage);
                return;
              }
              const execState = new Uint8Array(memory.buffer, bufPtr, written).slice();

              // 2. Create new kernel with new binary
              const newKernel = new WasmPosixKernel(initData.kernelConfig, createIO(initData), callbacks);
              await newKernel.init(msg.wasmBytes);
              const newInstance = newKernel.getInstance()!;
              const newMemory = newKernel.getMemory()!;

              // 3. Write exec state to new kernel memory and init
              const pages = Math.ceil(execState.byteLength / 65536) + 1;
              const sp = newMemory.grow(pages);
              const bp = sp * 65536;
              new Uint8Array(newMemory.buffer, bp, execState.byteLength).set(execState);

              const initFromExec = newInstance.exports.kernel_init_from_exec as
                (ptr: number, len: number, pid: number) => number;
              const result = initFromExec(bp, execState.byteLength, initData.pid);
              if (result < 0) {
                port.postMessage({
                  type: "error",
                  pid: initData.pid,
                  message: `kernel_init_from_exec failed: ${result}`,
                } satisfies WorkerToHostMessage);
                return;
              }

              // 4. Transfer shared pipe registrations from old kernel
              for (const [handle, entry] of kernel.getSharedPipes()) {
                newKernel.registerSharedPipe(handle, entry.pipe.getBuffer(), entry.end);
              }

              // Transfer signal wake SAB to new kernel
              if (initData.signalWakeSab) {
                newKernel.registerSignalWakeSab(initData.signalWakeSab);
              }

              // 5. Replace references
              kernel = newKernel;
              instance = newInstance;

              // 6. Notify host
              port.postMessage({
                type: "exec_complete",
                pid: initData.pid,
              } satisfies WorkerToHostMessage);
            } catch (err) {
              port.postMessage({
                type: "error",
                pid: initData.pid,
                message: `exec failed: ${err instanceof Error ? err.message : String(err)}`,
              } satisfies WorkerToHostMessage);
            }
          })();
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
