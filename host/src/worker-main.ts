import { WasmPosixKernel } from "./kernel";
import type { KernelCallbacks } from "./kernel";
import type { PlatformIO } from "./types";
import type {
  WorkerInitMessage,
  CentralizedWorkerInitMessage,
  ThreadInitMessage,
  WorkerToHostMessage,
  HostToWorkerMessage,
  RegisterPipeMessage,
  ConvertPipeMessage,
  ExecReplyMessage,
} from "./worker-protocol";
import { instantiateAndRunProgram, ASYNCIFY_DATA_SIZE } from "./program-runner";
import type { AsyncifyForkHandler } from "./program-runner";
import { SharedPipeBuffer } from "./shared-pipe-buffer";

export interface MessagePort {
  postMessage(msg: unknown, transferList?: unknown[]): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export type CreateIOFn = (initData: WorkerInitMessage) => PlatformIO;

/**
 * Convert kernel-internal pipes to SharedPipeBuffers and return the SABs.
 * Must be called while the worker is NOT blocked (before Atomics.wait).
 */
function convertPipesToShared(
  kernel: WasmPosixKernel,
): { handle: number; sab: SharedArrayBuffer; end: "read" | "write" }[] {
  const inst = kernel.getInstance()!;
  const mem = kernel.getMemory()!;
  const pipeSabs: { handle: number; sab: SharedArrayBuffer; end: "read" | "write" }[] = [];

  try {
    const getPipeOfds = inst.exports.kernel_get_pipe_ofds as
      (ptr: number, len: number) => number;
    const PIPE_BUF_PAGES = 1;
    const pipeBufPage = mem.grow(PIPE_BUF_PAGES);
    const pipeBufPtr = pipeBufPage * 65536;
    const pipeBufSize = PIPE_BUF_PAGES * 65536;
    const pipeCount = getPipeOfds(pipeBufPtr, pipeBufSize);

    if (pipeCount > 0) {
      const convertFn = inst.exports.kernel_convert_pipe_to_host as
        (ofdIdx: number, newHandle: bigint) => number;
      const pipeView = new DataView(mem.buffer, pipeBufPtr, pipeCount * 16);

      // Group pipe OFDs by host_handle (same pipe has same |host_handle|)
      const groups = new Map<bigint, { ofdIndex: number; isRead: boolean }[]>();
      for (let i = 0; i < pipeCount; i++) {
        const ofdIndex = pipeView.getUint32(i * 16, true);
        const hostHandle = pipeView.getBigInt64(i * 16 + 4, true);
        const isRead = pipeView.getUint32(i * 16 + 12, true) === 1;
        // Already converted pipes have positive host_handle; skip them
        if (hostHandle >= 0) continue;
        const key = hostHandle < 0n ? -hostHandle : hostHandle;
        const existing = groups.get(key);
        if (existing) existing.push({ ofdIndex, isRead });
        else groups.set(key, [{ ofdIndex, isRead }]);
      }

      // Create SharedPipeBuffer per pipe group, convert OFDs
      let nextHandle = 1000; // Start pipe handles high to avoid conflicts
      for (const ofds of groups.values()) {
        const sharedPipe = SharedPipeBuffer.create();
        const sab = sharedPipe.getBuffer();
        for (const ofd of ofds) {
          const handle = nextHandle++;
          const end = ofd.isRead ? "read" as const : "write" as const;
          kernel.registerSharedPipe(handle, sab, end);
          convertFn(ofd.ofdIndex, BigInt(handle));
          pipeSabs.push({ handle, sab, end });
        }
      }
    }
  } catch {
    // If pipe enumeration fails, proceed without pipe conversion
  }

  return pipeSabs;
}

/**
 * Serialize kernel fork state into a transferable ArrayBuffer.
 */
function serializeForkState(kernel: WasmPosixKernel): ArrayBuffer {
  const inst = kernel.getInstance()!;
  const mem = kernel.getMemory()!;
  const FORK_BUF_PAGES = 16;
  const sp = mem.grow(FORK_BUF_PAGES);
  const bp = sp * 65536;
  const bs = FORK_BUF_PAGES * 65536;
  const getForkState = inst.exports.kernel_get_fork_state as
    (ptr: number, len: number) => number;
  const written = getForkState(bp, bs);
  return written > 0
    ? new Uint8Array(mem.buffer, bp, written).slice().buffer
    : new ArrayBuffer(0);
}

export async function workerMain(
  port: MessagePort,
  initData: WorkerInitMessage,
  createIO: CreateIOFn,
): Promise<void> {
  try {
    // Track whether an exec is in progress. When exec succeeds, the kernel
    // traps (unreachable) to stop the old program. We use this flag to
    // distinguish an exec-trap from a bug-trap.
    let execInProgress = false;

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
        execInProgress = true;
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
      onWaitpid: (targetPid: number, options: number): void => {
        port.postMessage({
          type: "waitpid_request",
          pid: initData.pid,
          targetPid,
          options,
          waitpidSab: initData.waitpidSab!,
        } satisfies WorkerToHostMessage);
      },
      onFork: (forkSab: SharedArrayBuffer): void => {
        // Non-asyncify fork path: kernel called host_fork directly.
        // Convert pipes, serialize state, and send fork_request.
        const pipeSabs = convertPipesToShared(kernel);
        const forkState = serializeForkState(kernel);
        port.postMessage({
          type: "fork_request",
          pid: initData.pid,
          forkSab,
          forkState,
          pipeSabs: pipeSabs.map(p => ({ handle: p.handle, sab: p.sab, end: p.end })),
        } satisfies WorkerToHostMessage,
        [forkState]);
      },
      onClone: (fnPtr: number, arg: number, stackPtr: number, tlsPtr: number, ctidPtr: number): number => {
        // Thread clone: post clone_request and block until host assigns a TID.
        const mem = kernel.getMemory()!;
        const cloneSab = new SharedArrayBuffer(8); // [flag, tid]
        const view = new Int32Array(cloneSab);
        Atomics.store(view, 0, 0);
        Atomics.store(view, 1, 0);
        port.postMessage({
          type: "clone_request",
          pid: initData.pid,
          fnPtr,
          argPtr: arg,
          stackPtr,
          tlsPtr,
          ctidPtr,
          cloneSab,
          memory: mem,
        } satisfies WorkerToHostMessage);
        // Block until host signals back with TID
        Atomics.wait(view, 0, 0, 3000);
        const tid = Atomics.load(view, 1);
        return tid; // TID or negative errno
      },
    };

    let kernel = new WasmPosixKernel(initData.kernelConfig, createIO(initData), callbacks);
    await kernel.init(initData.wasmBytes);

    let instance = kernel.getInstance()!;

    if (initData.signalWakeSab) {
      kernel.registerSignalWakeSab(initData.signalWakeSab);
    }

    if (initData.lockTableSab) {
      kernel.registerSharedLockTable(initData.lockTableSab);
    }

    if (initData.ipcSab) {
      kernel.registerSharedIpcTable(initData.ipcSab);
    }

    kernel.pid = initData.pid;

    if (initData.forkSab) {
      kernel.registerForkSab(initData.forkSab);
    }

    if (initData.waitpidSab) {
      kernel.registerWaitpidSab(initData.waitpidSab);
    }

    // ── Fork child with asyncify resume ────────────────────────────
    // If asyncifyResume is present, the child resumes from the parent's
    // fork point via asyncify rewind. We skip kernel_init_from_fork
    // because the memory snapshot already contains the parent's kernel state;
    // kernel_set_child_pid fixes the PID afterward.
    if (initData.asyncifyResume) {
      // Kernel was freshly init'd by WasmPosixKernel constructor.
      // We don't call kernel_init or kernel_init_from_fork — the memory
      // snapshot restore in instantiateAndRunProgram handles everything.

      port.postMessage({
        type: "ready",
        pid: initData.pid,
      } satisfies WorkerToHostMessage);

      if (initData.programBytes) {
        (async () => {
          try {
            const exitCode = await instantiateAndRunProgram(
              kernel,
              initData.programBytes!,
              {
                forkHandler: createAsyncifyForkHandler(kernel, port, initData),
                resumeFromFork: {
                  memorySnapshot: initData.asyncifyResume!.memorySnapshot,
                  asyncifyData: initData.asyncifyResume!.asyncifyData,
                  asyncifyDataAddr: initData.asyncifyResume!.asyncifyDataAddr,
                  childPid: initData.pid,
                },
              },
            );
            if (!execInProgress) {
              port.postMessage({
                type: "exit",
                pid: initData.pid,
                status: exitCode,
              } satisfies WorkerToHostMessage);
            }
          } catch (err) {
            if (execInProgress) return;
            port.postMessage({
              type: "error",
              pid: initData.pid,
              message: `Program failed: ${err instanceof Error ? err.message : String(err)}`,
            } satisfies WorkerToHostMessage);
          }
        })();
      }

      // Set up message listener and return
      setupMessageListener(port, kernel, instance, initData, createIO, callbacks);
      return;
    }

    // ── Standard fork/init path ────────────────────────────────────
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

    // Check if this is a fork child with pending exec (posix_spawn pattern).
    // If so, apply fd_actions and send exec_request instead of running programBytes.
    let forkChildHandledExec = false;
    if (initData.forkState) {
      const isForkChild = instance.exports.kernel_is_fork_child as () => number;
      if (isForkChild() === 1) {
        const getExecPath = instance.exports.kernel_get_fork_exec_path as
          (ptr: number, len: number) => number;
        const memory = kernel.getMemory()!;
        const pathBufPage = memory.grow(1);
        const pathBufPtr = pathBufPage * 65536;
        const pathLen = getExecPath(pathBufPtr, 65536);
        if (pathLen > 0) {
          // Apply fd actions (dup2, close) before exec
          const applyFdActions = instance.exports.kernel_apply_fork_fd_actions as () => number;
          applyFdActions();

          // Set argv from fork_exec_argv so exec state captures the right argv
          const getArgc = instance.exports.kernel_get_fork_exec_argc as () => number;
          const getArgv = instance.exports.kernel_get_fork_exec_argv as
            (idx: number, ptr: number, len: number) => number;
          const clearArgv = instance.exports.kernel_clear_argv as () => void;
          const pushArgv = instance.exports.kernel_push_argv as
            (ptr: number, len: number) => void;
          const argc = getArgc();
          if (argc > 0) {
            clearArgv();
            for (let i = 0; i < argc; i++) {
              const argLen = getArgv(i, pathBufPtr, 65536);
              if (argLen > 0) {
                pushArgv(pathBufPtr, argLen);
              }
            }
          }

          // Read exec path
          // Re-read since getArgv may have overwritten pathBufPtr
          const pathLen2 = getExecPath(pathBufPtr, 65536);
          const pathBytes = new Uint8Array(memory.buffer, pathBufPtr, pathLen2);
          const execPath = new TextDecoder().decode(pathBytes);

          // Send exec_request to host — exec_reply handler will start the new program
          port.postMessage({
            type: "exec_request",
            pid: initData.pid,
            path: execPath,
          } satisfies WorkerToHostMessage);
          forkChildHandledExec = true;
        }
      }
    }

    // If programBytes provided and not already handling fork+exec,
    // run the user program after signaling ready.
    if (initData.programBytes && !forkChildHandledExec) {
      (async () => {
        try {
          const exitCode = await instantiateAndRunProgram(
            kernel,
            initData.programBytes!,
            {
              forkHandler: createAsyncifyForkHandler(kernel, port, initData),
            },
          );
          if (!execInProgress) {
            port.postMessage({
              type: "exit",
              pid: initData.pid,
              status: exitCode,
            } satisfies WorkerToHostMessage);
          }
          // If exec is in progress, the exec_reply handler will send exit.
        } catch (err) {
          if (execInProgress) {
            // Exec succeeded — the kernel trapped to stop the old program.
            // The exec_reply handler will run the new program.
            return;
          }
          port.postMessage({
            type: "error",
            pid: initData.pid,
            message: `Program failed: ${err instanceof Error ? err.message : String(err)}`,
          } satisfies WorkerToHostMessage);
        }
      })();
    }

    // Listen for messages from host
    setupMessageListener(port, kernel, instance, initData, createIO, callbacks);
  } catch (err) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerToHostMessage);
  }
}

/**
 * Create an AsyncifyForkHandler that does pipe conversion, takes a memory
 * snapshot, serializes fork state, sends fork_request, and blocks on
 * Atomics.wait until the host signals back with the child PID.
 */
function createAsyncifyForkHandler(
  kernel: WasmPosixKernel,
  port: MessagePort,
  initData: WorkerInitMessage,
): AsyncifyForkHandler {
  return {
    handleFork(
      asyncifyData: ArrayBuffer,
      asyncifyDataAddr: number,
      memory: WebAssembly.Memory,
    ): number {
      // 1. Convert pipes to SharedPipeBuffers (modifies kernel state in memory)
      const pipeSabs = convertPipesToShared(kernel);

      // 2. Take memory snapshot AFTER pipe conversion
      const memorySnapshot = new Uint8Array(memory.buffer).slice().buffer;

      // 3. Serialize kernel fork state (for non-asyncify metadata)
      const forkState = serializeForkState(kernel);

      // 4. Use the worker's forkSab to synchronize with host
      const forkSab = initData.forkSab!;
      const view = new Int32Array(forkSab);
      Atomics.store(view, 0, 0); // flag = waiting
      Atomics.store(view, 1, 0); // result = 0

      // 5. Send fork_request with all data
      port.postMessage({
        type: "fork_request",
        pid: initData.pid,
        forkSab,
        forkState,
        pipeSabs: pipeSabs.map(p => ({ handle: p.handle, sab: p.sab, end: p.end })),
        asyncifyData: {
          memorySnapshot,
          asyncifyData: asyncifyData.slice(0),
          asyncifyDataAddr,
        },
      } satisfies WorkerToHostMessage,
      [forkState, memorySnapshot]);

      // 6. Block until host creates the child and signals back
      Atomics.wait(view, 0, 0);
      const result = Atomics.load(view, 1);

      // 7. Return child PID (or negative errno)
      return result;
    },
  };
}

/**
 * Set up the message listener for host→worker messages.
 * Extracted as a function so both the asyncify and standard paths can use it.
 */
function setupMessageListener(
  port: MessagePort,
  kernel: WasmPosixKernel,
  instance: WebAssembly.Instance,
  initData: WorkerInitMessage,
  createIO: CreateIOFn,
  callbacks: KernelCallbacks,
): void {
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

            // Transfer lock table SAB to new kernel
            if (initData.lockTableSab) {
              newKernel.registerSharedLockTable(initData.lockTableSab);
            }

            if (initData.ipcSab) {
              newKernel.registerSharedIpcTable(initData.ipcSab);
            }

            newKernel.pid = initData.pid;

            // Transfer fork SAB to new kernel
            if (initData.forkSab) {
              newKernel.registerForkSab(initData.forkSab);
            }

            // Transfer waitpid SAB to new kernel
            if (initData.waitpidSab) {
              newKernel.registerWaitpidSab(initData.waitpidSab);
            }

            // 5. Replace references
            kernel = newKernel;
            instance = newInstance;

            // 6. Notify host
            port.postMessage({
              type: "exec_complete",
              pid: initData.pid,
            } satisfies WorkerToHostMessage);

            // 7. If exec_reply includes programBytes, run the new program
            if (msg.programBytes) {
              const exitCode = await instantiateAndRunProgram(
                kernel,
                msg.programBytes,
                { forkHandler: createAsyncifyForkHandler(kernel, port, initData) },
              );
              port.postMessage({
                type: "exit",
                pid: initData.pid,
                status: exitCode,
              } satisfies WorkerToHostMessage);
            }
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
}

/**
 * Walk a thread's robust futex list on exit and mark held mutexes as OWNER_DIED.
 *
 * struct robust_list_head (wasm32, long=4):
 *   offset 0: list.next — pointer to first entry (or &list if empty)
 *   offset 4: futex_offset — offset from list entry to futex word
 *   offset 8: list_op_pending — in-progress lock operation
 *
 * For each entry, the futex word (mutex __lock) contains:
 *   bits 0-29: owner TID
 *   bit 30: FUTEX_OWNER_DIED (0x40000000)
 *   bit 31: FUTEX_WAITERS (0x80000000)
 */
function walkRobustList(memory: WebAssembly.Memory, tid: number, headPtr: number): void {
  if (headPtr === 0) return;
  const FUTEX_OWNER_DIED = 0x40000000;
  const TID_MASK = 0x3FFFFFFF;
  const MAX_ENTRIES = 1024; // safety limit

  try {
    const dv = new DataView(memory.buffer);
    const i32 = new Int32Array(memory.buffer);

    // Read robust_list_head fields
    const listNext = dv.getUint32(headPtr, true);
    const futexOffset = dv.getInt32(headPtr + 4, true);
    const pending = dv.getUint32(headPtr + 8, true);

    // Handle pending entry first (entry that was being locked when thread died)
    if (pending !== 0) {
      handleRobustEntry(dv, i32, pending, futexOffset, tid, FUTEX_OWNER_DIED, TID_MASK);
    }

    // Walk the linked list. The list is circular — head.list.next points to
    // the first entry, and the last entry points back to &head.list (= headPtr).
    let entry = listNext;
    for (let count = 0; count < MAX_ENTRIES && entry !== headPtr && entry !== 0; count++) {
      if (entry !== pending) {
        handleRobustEntry(dv, i32, entry, futexOffset, tid, FUTEX_OWNER_DIED, TID_MASK);
      }
      // Bit 0 of next pointer is the PI flag; mask it off
      entry = dv.getUint32(entry, true) & ~1;
    }
  } catch {
    // Memory access errors are non-fatal — thread is exiting anyway
  }
}

function handleRobustEntry(
  dv: DataView,
  i32: Int32Array,
  entryAddr: number,
  futexOffset: number,
  tid: number,
  FUTEX_OWNER_DIED: number,
  TID_MASK: number,
): void {
  const futexAddr = entryAddr + futexOffset;
  const futexIndex = futexAddr >>> 2;
  // CAS loop: set FUTEX_OWNER_DIED if we own it
  let oldVal = Atomics.load(i32, futexIndex);
  while ((oldVal & TID_MASK) === tid) {
    const newVal = (oldVal & ~TID_MASK) | FUTEX_OWNER_DIED;
    const actual = Atomics.compareExchange(i32, futexIndex, oldVal, newVal);
    if (actual === oldVal) {
      // Successfully marked; wake one waiter
      Atomics.notify(i32, futexIndex, 1);
      break;
    }
    oldVal = actual;
  }
}

/**
 * Build minimal JavaScript kernel stubs for thread workers.
 *
 * Thread workers cannot instantiate the Wasm kernel module because its active
 * data segments would overwrite the parent's kernel state in shared memory.
 * Instead, we provide JavaScript functions that implement just the syscalls
 * needed by musl's __pthread_exit path (futex, sigprocmask, exit, write).
 * All other syscalls return -ENOSYS.
 */
function buildThreadKernelStubs(
  memory: WebAssembly.Memory,
  tid: number,
  io: PlatformIO,
): { imports: Record<string, (...args: number[]) => number | bigint | void>; getRobustListHead: () => number } {
  const ENOSYS = -38;

  // Robust futex list head pointer — set by set_robust_list, walked on thread exit.
  let robustListHead = 0;

  // Default stub — returns -ENOSYS for any unimplemented kernel function.
  // The program module imports ~168 kernel functions; most are unused by threads.
  const defaultStub = () => ENOSYS;

  // i64-returning functions need to return BigInt
  const defaultStub64 = () => BigInt(ENOSYS);

  const stubs: Record<string, (...args: number[]) => number | bigint | void> = {
    // ── Identity ──
    kernel_getpid: () => 1,
    kernel_getppid: () => 0,
    kernel_gettid: () => tid,
    kernel_getuid: () => 0,
    kernel_geteuid: () => 0,
    kernel_getgid: () => 0,
    kernel_getegid: () => 0,
    kernel_getpgrp: () => 1,

    // ── Futex (critical for __tl_lock / __tl_unlock / pthread_join) ──
    kernel_futex: (uaddr: number, op: number, val: number, timeout: number, _uaddr2: number, _val3: number): number => {
      const i32 = new Int32Array(memory.buffer);
      const index = uaddr >>> 2;
      const FUTEX_PRIVATE = 128;
      const FUTEX_CLOCK_REALTIME = 256;
      const opCode = op & ~(FUTEX_PRIVATE | FUTEX_CLOCK_REALTIME);
      const FUTEX_WAIT = 0;
      const FUTEX_WAKE = 1;
      const FUTEX_REQUEUE = 3;
      const FUTEX_CMP_REQUEUE = 4;
      const FUTEX_WAIT_BITSET = 9;
      const FUTEX_WAKE_BITSET = 10;

      if (opCode === FUTEX_WAIT || opCode === FUTEX_WAIT_BITSET) {
        const actual = Atomics.load(i32, index);
        if (actual !== val) return -11; // -EAGAIN (not-equal)

        // Read timeout from shared memory if provided.
        // struct timespec (wasm32 time64): { tv_sec: i64, tv_nsec: i32, pad: i32 } = 16 bytes
        let timeoutMs: number | undefined;
        if (timeout !== 0) {
          const dv = new DataView(memory.buffer);
          const sec = Number(dv.getBigInt64(timeout, true));
          const nsec = dv.getInt32(timeout + 8, true);
          const totalMs = sec * 1000 + Math.floor(nsec / 1_000_000);
          timeoutMs = Math.max(0, totalMs);
        }

        const result = Atomics.wait(i32, index, val, timeoutMs);
        if (result === "ok" || result === "not-equal") return 0;
        return -110; // -ETIMEDOUT
      } else if (opCode === FUTEX_WAKE || opCode === FUTEX_WAKE_BITSET) {
        return Atomics.notify(i32, index, val);
      } else if (opCode === FUTEX_REQUEUE) {
        // Can't truly requeue; wake val + val2 on uaddr instead.
        // timeout param is repurposed as val2 (max requeue count).
        return Atomics.notify(i32, index, val + timeout);
      } else if (opCode === FUTEX_CMP_REQUEUE) {
        const actual = Atomics.load(i32, index);
        if (actual !== _val3) return -11; // -EAGAIN
        return Atomics.notify(i32, index, val + timeout);
      }
      return ENOSYS;
    },

    // ── Signals (no-op for threads) ──
    // sigprocmask returns i64 in the Wasm ABI
    kernel_sigprocmask: (_how: number, _set: number, _oldset: number) => 0n,
    kernel_sigaction: (_sig: number, _act: number, _oact: number, _sigsetsize: number) => 0,
    kernel_signal: (_sig: number, _handler: number) => 0,
    kernel_sigsuspend: () => ENOSYS,
    kernel_raise: () => 0,
    kernel_kill: () => 0,
    kernel_rt_sigtimedwait: () => ENOSYS,

    // ── Exit ──
    kernel_exit: (_status: number): void => {
      // No-op — the unreachable instruction after __unmapself will trap,
      // which the host catches to clean up the thread.
    },

    // ── Memory (minimal support) ──
    kernel_mmap: (_addr: number, len: number, _prot: number, _flags: number, _fd: number, _offset: number): number => {
      // Simple bump allocator using memory.grow
      const pages = Math.ceil(len / 65536) || 1;
      const page = memory.grow(pages);
      if (page === -1) return -12; // -ENOMEM
      return page * 65536;
    },
    kernel_munmap: () => 0,
    kernel_mprotect: () => 0,
    kernel_brk: (addr: number) => addr, // no-op, return requested addr
    kernel_madvise: () => 0,
    kernel_mremap: () => ENOSYS,

    // ── Thread-related ──
    kernel_set_tid_address: (_addr: number) => tid,
    kernel_set_robust_list: (head: number, _len: number) => {
      robustListHead = head;
      return 0;
    },
    kernel_get_robust_list: () => 0,
    kernel_clone: () => ENOSYS,
    kernel_fork: () => ENOSYS,

    // ── I/O (minimal — just write for debug output) ──
    kernel_write: (fd: number, bufPtr: number, len: number): number => {
      if (fd === 1 || fd === 2) {
        const bytes = new Uint8Array(memory.buffer, bufPtr, len);
        try {
          io.write(fd, bytes, null, len);
        } catch { /* ignore */ }
        return len;
      }
      return ENOSYS;
    },
    kernel_writev: (fd: number, iovPtr: number, iovCnt: number): number => {
      if (fd !== 1 && fd !== 2) return ENOSYS;
      const dv = new DataView(memory.buffer);
      let totalWritten = 0;
      for (let i = 0; i < iovCnt; i++) {
        const base = dv.getUint32(iovPtr + i * 8, true);
        const len = dv.getUint32(iovPtr + i * 8 + 4, true);
        if (len > 0) {
          const bytes = new Uint8Array(memory.buffer, base, len);
          try {
            io.write(fd, bytes, null, len);
          } catch { /* ignore */ }
          totalWritten += len;
        }
      }
      return totalWritten;
    },
    kernel_read: () => ENOSYS,
    kernel_open: () => ENOSYS,
    kernel_close: () => 0,

    // ── Time ──
    kernel_clock_gettime: (clockId: number, tp: number): number => {
      const now = Date.now();
      const sec = Math.floor(now / 1000);
      const nsec = (now % 1000) * 1_000_000;
      const view = new DataView(memory.buffer);
      // struct timespec for wasm32 time64: { tv_sec: i64, tv_nsec: i64 } = 16 bytes
      // (tv_nsec is actually i32 in C but kernel WasmTimespec uses i64; writing i64 is safe
      // because the upper 32 bits are 0 and land in the padding field)
      view.setBigInt64(tp, BigInt(sec), true);
      view.setBigInt64(tp + 8, BigInt(nsec), true);
      return 0;
    },
    kernel_clock_getres: (_clockId: number, tp: number): number => {
      if (tp !== 0) {
        const view = new DataView(memory.buffer);
        view.setBigInt64(tp, 0n, true);
        view.setBigInt64(tp + 8, 1000000n, true); // 1ms resolution
      }
      return 0;
    },
    kernel_gettimeofday: (tv: number) => {
      const now = Date.now();
      const sec = Math.floor(now / 1000);
      const usec = (now % 1000) * 1000;
      const view = new DataView(memory.buffer);
      // struct timeval for wasm32: { tv_sec: i64, tv_usec: i64 } = 16 bytes
      view.setBigInt64(tv, BigInt(sec), true);
      view.setBigInt64(tv + 8, BigInt(usec), true);
      return 0;
    },
    kernel_nanosleep: () => 0,
    kernel_usleep: () => 0,

    // ── Misc no-ops ──
    kernel_sysconf: (_name: number) => -1n, // returns i64
    kernel_umask: () => 0o22,
    kernel_prctl: () => ENOSYS,
    kernel_getrlimit: () => ENOSYS,
    kernel_setrlimit: () => ENOSYS,
    kernel_getrusage: () => ENOSYS,
    kernel_isatty: () => 0,
    kernel_getrandom: (buf: number, len: number): number => {
      const bytes = new Uint8Array(memory.buffer, buf, len);
      crypto.getRandomValues(bytes);
      return len;
    },

    // ── i64-returning functions ──
    kernel_lseek: defaultStub64 as () => bigint,
    kernel_time: () => BigInt(Math.floor(Date.now() / 1000)),
    kernel_telldir: defaultStub64 as () => bigint,
    kernel_fpathconf: defaultStub64 as () => bigint,

    // ── Void-returning functions ──
    kernel_push_argv: (): void => {},
    kernel_rewinddir: (): void => {},
    kernel_seekdir: (): void => {},
  };

  // Functions that return i64 in the Wasm ABI (must return BigInt)
  const i64Functions = new Set([
    "kernel_lseek", "kernel_time", "kernel_telldir",
    "kernel_fpathconf", "kernel_pathconf", "kernel_sysconf",
    "kernel_sigprocmask",
  ]);

  // Return a Proxy that falls back to defaultStub for any missing function
  const imports = new Proxy(stubs, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (i64Functions.has(prop)) {
        return () => BigInt(ENOSYS);
      }
      return () => ENOSYS;
    },
  });
  return { imports, getRobustListHead: () => robustListHead };
}

/**
 * Thread worker entry point. Shares the parent's Memory but has its own
 * program Wasm instance. Provides JavaScript kernel stubs instead of a Wasm
 * kernel to avoid corrupting the parent's kernel state in shared memory.
 */
export async function threadWorkerMain(
  port: MessagePort,
  initData: ThreadInitMessage,
  createIO: CreateIOFn,
): Promise<void> {
  let getRobustListHead: (() => number) | undefined;
  try {
    // Use the parent's shared Memory — threads share the same linear memory.
    const memory = initData.memory;

    // Thread workers do NOT instantiate the Wasm kernel module. The kernel
    // stores its state (Process struct, FD table) in the shared linear memory,
    // so instantiating a second kernel would overwrite the parent's state via
    // active data segments. Instead, provide JavaScript kernel stubs that
    // operate directly on the shared program memory.
    const tid = initData.tid;
    const io = createIO({
      type: "init",
      pid: tid,
      ppid: 0,
      wasmBytes: initData.wasmBytes,
      kernelConfig: initData.kernelConfig,
    });

    // Instantiate the user program module against the shared memory
    if (initData.programModule || initData.programBytes) {
      const programModule = initData.programModule ?? await WebAssembly.compile(initData.programBytes!);

      // Build kernel stubs — minimal syscall implementations for threads.
      const stubResult = buildThreadKernelStubs(memory, tid, io);
      const kernelStubs = stubResult.imports;
      getRobustListHead = stubResult.getRobustListHead;
      const programImports: WebAssembly.Imports = {
        kernel: kernelStubs,
        env: { memory },
      };

      const programInstance = await WebAssembly.instantiate(programModule, programImports);

      // Initialize LLVM TLS block for this thread instance.
      // _Thread_local variables are relative to __tls_base; __wasm_init_tls
      // copies the TLS template into a fresh block so each thread has its own.
      const initTls = programInstance.exports.__wasm_init_tls as
        ((base: number) => void) | undefined;
      const tlsSize = programInstance.exports.__tls_size as
        WebAssembly.Global | undefined;

      if (initTls && tlsSize) {
        const size = (tlsSize.value as number) || 64;
        const alignedSize = (size + 15) & ~15; // 16-byte align
        const pages = Math.ceil(alignedSize / 65536) || 1;
        const page = memory.grow(pages);
        const tlsBlock = page * 65536;
        initTls(tlsBlock);
      }

      // Set __stack_pointer to the thread's allocated stack so the thread
      // doesn't corrupt the parent's stack in shared memory.
      const stackPointer = programInstance.exports.__stack_pointer as
        WebAssembly.Global | undefined;
      if (stackPointer && initData.stackPtr) {
        stackPointer.value = initData.stackPtr;
      }

      // Set the thread pointer via __wasm_thread_init
      const threadInit = programInstance.exports.__wasm_thread_init as
        ((tp: number) => void) | undefined;
      if (threadInit) {
        threadInit(initData.tlsPtr);
      }

      // Get the function table to call the thread entry function
      const funcTable = programInstance.exports.__indirect_function_table as
        WebAssembly.Table | undefined;
      if (!funcTable) {
        throw new Error("Thread: no __indirect_function_table export");
      }

      // Call the thread entry function: fn(arg)
      let exitCode = 0;
      try {
        const threadFn = funcTable.get(initData.fnPtr) as ((arg: number) => number) | null;
        if (threadFn) {
          // CRITICAL: Copy the start_args struct from parent's stack (in shared
          // memory) to a child-local region. The parent may have already returned
          // from pthread_create by the time we get here, overwriting the args on
          // its stack. Allocate a fresh page for the copy.
          const argsPage = memory.grow(1);
          const argsCopyBase = argsPage * 65536;
          const ARGS_COPY_SIZE = 256; // generous — musl's start_args is ~48 bytes
          const src = new Uint8Array(memory.buffer, initData.argPtr, ARGS_COPY_SIZE);
          const dst = new Uint8Array(memory.buffer, argsCopyBase, ARGS_COPY_SIZE);
          dst.set(src);

          exitCode = threadFn(argsCopyBase) || 0;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("unreachable")) {
          exitCode = 0;
        } else {
          throw e;
        }
      }

      // Walk the robust futex list — mark any held mutexes with FUTEX_OWNER_DIED
      // so waiters get EOWNERDEAD instead of blocking forever.
      if (getRobustListHead) walkRobustList(memory, tid, getRobustListHead());

      // Thread exit: signal ctid and tid for pthread_join.
      // musl's __pthread_exit already wrote self->tid = 0 in shared memory
      // before the thread trapped. We need to:
      // 1. Write 0 to *ctid (CLONE_CHILD_CLEARTID — __thread_list_lock)
      // 2. futex_wake on self->tid so pthread_join's __wait unblocks
      const i32view = new Int32Array(memory.buffer);
      if (initData.ctidPtr !== 0) {
        Atomics.store(i32view, initData.ctidPtr >>> 2, 0);
        Atomics.notify(i32view, initData.ctidPtr >>> 2, 1);
      }
      // tid is at offset 24 in struct pthread; tlsPtr IS the struct pointer
      const PTHREAD_TID_OFFSET = 24;
      const tidAddr = initData.tlsPtr + PTHREAD_TID_OFFSET;
      const tidIndex = tidAddr >>> 2;
      Atomics.store(i32view, tidIndex, 0);
      Atomics.notify(i32view, tidIndex, Infinity);

      port.postMessage({
        type: "thread_exit",
        tid: initData.tid,
        exitCode,
      } satisfies WorkerToHostMessage);
    }
  } catch (err) {
    // Walk robust list even on crash — mark held mutexes as OWNER_DIED
    if (initData.memory && getRobustListHead) {
      try { walkRobustList(initData.memory, initData.tid, getRobustListHead()); } catch { /* */ }
    }
    // Always signal ctid and tid so parent doesn't hang on pthread_join
    if (initData.memory) {
      try {
        const i32view = new Int32Array(initData.memory.buffer);
        if (initData.ctidPtr !== 0) {
          Atomics.store(i32view, initData.ctidPtr >>> 2, 0);
          Atomics.notify(i32view, initData.ctidPtr >>> 2, 1);
        }
        const PTHREAD_TID_OFFSET = 24;
        const tidAddr = initData.tlsPtr + PTHREAD_TID_OFFSET;
        Atomics.store(i32view, tidAddr >>> 2, 0);
        Atomics.notify(i32view, tidAddr >>> 2, Infinity);
      } catch { /* ignore — memory may be detached */ }
    }
    port.postMessage({
      type: "thread_exit",
      tid: initData.tid,
      exitCode: -1,
    } satisfies WorkerToHostMessage);
  }
}

// =========================================================================
// Centralized-mode Worker entry point
// =========================================================================

/**
 * Entry point for process Workers in centralized kernel mode.
 *
 * Unlike workerMain(), this does NOT instantiate a WasmPosixKernel.
 * The user program (compiled with channel_syscall.c) communicates with
 * the centralized kernel via atomic channel IPC in shared Memory.
 *
 * The Worker's job is simply to:
 * 1. Compile and instantiate the user Wasm module
 * 2. Set up TLS (including __channel_base for the syscall channel)
 * 3. Run _start
 * 4. Report exit
 */
export async function centralizedWorkerMain(
  port: MessagePort,
  initData: CentralizedWorkerInitMessage,
): Promise<void> {
  try {
    const { memory, programBytes, channelOffset, pid } = initData;

    // Compile the user program module
    const module = await WebAssembly.compile(programBytes);

    // Build imports. Channel-mode programs use channel_syscall.c for syscalls,
    // but the musl overlay CRT still imports kernel.* functions for argc/argv,
    // environ, fork state, and clone.
    const envImports: Record<string, WebAssembly.ExportValue> = { memory };

    // Prepare argv/environ data for kernel.* CRT imports
    const argv = initData.argv || [];
    const envVars = initData.env || [];
    const encoder = new TextEncoder();

    const kernelImports: Record<string, WebAssembly.ExportValue> = {
      // CRT argv support
      kernel_get_argc: (): number => argv.length,
      kernel_argv_read: (index: number, bufPtr: number, bufMax: number): number => {
        if (index >= argv.length) return 0;
        const encoded = encoder.encode(argv[index]);
        const len = Math.min(encoded.length, bufMax);
        new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
        return len;
      },

      // CRT environ support
      kernel_environ_count: (): number => envVars.length,
      kernel_environ_get: (index: number, bufPtr: number, bufMax: number): number => {
        if (index >= envVars.length) return -1;
        const encoded = encoder.encode(envVars[index]);
        const len = Math.min(encoded.length, bufMax);
        new Uint8Array(memory.buffer, bufPtr, len).set(encoded.subarray(0, len));
        return len;
      },

      // Fork/exec state — not a fork child in centralized mode
      kernel_is_fork_child: (): number => 0,
      kernel_apply_fork_fd_actions: (): number => 0,
      kernel_get_fork_exec_path: (_buf: number, _max: number): number => 0,
      kernel_get_fork_exec_argc: (): number => 0,
      kernel_get_fork_exec_argv: (_index: number, _buf: number, _max: number): number => 0,
      kernel_push_argv: (_ptr: number, _len: number): number => 0,
      kernel_clear_fork_exec: (): number => 0,

      // Exec dispatches through channel
      kernel_execve: (_pathPtr: number): number => -38, // ENOSYS

      // Exit dispatches through channel (SYS_EXIT)
      kernel_exit: (status: number): void => {
        const view = new DataView(memory.buffer);
        const base = channelOffset;
        view.setInt32(base + 4, 34, true); // SYS_EXIT = 34
        view.setInt32(base + 8, status, true);
        const i32 = new Int32Array(memory.buffer);
        Atomics.store(i32, base / 4, 1); // CH_PENDING
        Atomics.notify(i32, base / 4, 1);
        // Wait for complete, then trap
        while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }
        Atomics.store(i32, base / 4, 0);
      },

      // Clone dispatches through channel (SYS_CLONE)
      kernel_clone: (fnPtr: number, stackPtr: number, flags: number,
        arg: number, ptidPtr: number, tlsPtr: number, ctidPtr: number): number => {
        const SYS_CLONE_NR = 201;
        const view = new DataView(memory.buffer);
        const base = channelOffset;
        view.setInt32(base + 4, SYS_CLONE_NR, true);
        view.setInt32(base + 8, flags, true);
        view.setInt32(base + 12, stackPtr, true);
        view.setInt32(base + 16, ptidPtr, true);
        view.setInt32(base + 20, tlsPtr, true);
        view.setInt32(base + 24, ctidPtr, true);
        view.setInt32(base + 28, 0, true);
        // Write fn_ptr and arg_ptr to CH_DATA area for handleClone
        view.setUint32(base + 40, fnPtr, true);
        view.setUint32(base + 44, arg, true);

        const i32 = new Int32Array(memory.buffer);
        Atomics.store(i32, base / 4, 1); // CH_PENDING
        Atomics.notify(i32, base / 4, 1);
        while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

        const result = view.getInt32(base + 32, true);
        const err = view.getUint32(base + 36, true);
        Atomics.store(i32, base / 4, 0);

        if (err) return -err;
        return result;
      },

      // Fork dispatches through channel (SYS_FORK)
      kernel_fork: (): number => {
        const SYS_FORK_NR = 212;
        const view = new DataView(memory.buffer);
        const base = channelOffset;
        view.setInt32(base + 4, SYS_FORK_NR, true);
        for (let i = 0; i < 6; i++) view.setInt32(base + 8 + i * 4, 0, true);

        const i32 = new Int32Array(memory.buffer);
        Atomics.store(i32, base / 4, 1); // CH_PENDING
        Atomics.notify(i32, base / 4, 1);
        while (Atomics.wait(i32, base / 4, 1) === "ok") { /* */ }

        const result = view.getInt32(base + 32, true);
        const err = view.getUint32(base + 36, true);
        Atomics.store(i32, base / 4, 0);

        if (err) return -err;
        return result;
      },
    };

    // Stub any remaining unresolved function imports
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.kind !== "function") continue;
      if (imp.module === "env") {
        if (!envImports[imp.name]) {
          envImports[imp.name] = (..._args: unknown[]) => {
            throw new Error(`Unimplemented import: env.${imp.name}`);
          };
        }
      } else if (imp.module === "kernel") {
        if (!kernelImports[imp.name]) {
          kernelImports[imp.name] = (..._args: unknown[]) => 0;
        }
      }
    }

    const importObject: WebAssembly.Imports = { env: envImports };
    if (Object.keys(kernelImports).length > 0) {
      importObject.kernel = kernelImports;
    }
    const instance = await WebAssembly.instantiate(module, importObject);

    // Set __channel_base in TLS so __do_syscall knows where the channel is.
    // The main thread's TLS is already initialized by __wasm_init_memory
    // (the module's start function) during instantiation. We just need to
    // write __channel_base at the correct TLS offset.
    //
    // __tls_base global points to the start of the current thread's TLS block.
    // __channel_base is a _Thread_local uint32_t in .tbss, typically at offset 0.
    const tlsBase = instance.exports.__tls_base as WebAssembly.Global | undefined;
    if (tlsBase) {
      const tlsBaseAddr = tlsBase.value as number;
      const view = new DataView(memory.buffer);
      // __channel_base is the first (and often only) .tbss variable
      view.setUint32(tlsBaseAddr, channelOffset, true);
    }

    // Also push argv/env into the kernel process so kernel-side syscalls
    // (like getenv via channel) can access them. We do this by dispatching
    // SYS_SETENV through the channel for each env var, and pushing argv
    // via the kernel imports we just set up.
    // For now, kernel_push_argv and env are handled by the CRT imports above.

    // Signal ready
    port.postMessage({
      type: "ready",
      pid,
    } satisfies WorkerToHostMessage);

    // Run the program
    let exitCode = 0;
    try {
      const start = instance.exports._start as (() => void) | undefined;
      if (start) {
        start();
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("unreachable")) {
        // Normal exit via kernel_exit → unreachable trap
        exitCode = 0;
      } else {
        throw e;
      }
    }

    port.postMessage({
      type: "exit",
      pid,
      status: exitCode,
    } satisfies WorkerToHostMessage);
  } catch (err) {
    port.postMessage({
      type: "error",
      pid: initData.pid,
      message: `Centralized worker failed: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies WorkerToHostMessage);
  }
}
