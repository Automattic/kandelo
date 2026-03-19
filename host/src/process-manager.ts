import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
import type { KernelConfig } from "./types";
import type {
  WorkerInitMessage,
  ThreadInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import { SharedPipeBuffer } from "./shared-pipe-buffer";
import { SharedLockTable } from "./shared-lock-table";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  worker: WorkerHandle;
  state: "starting" | "running" | "zombie";
  exitStatus?: number;
  alarmTimer?: ReturnType<typeof setTimeout>;
  signalWakeSab?: SharedArrayBuffer;
  forkSab?: SharedArrayBuffer;
  waitpidSab?: SharedArrayBuffer;
  programBytes?: ArrayBuffer;
}

export interface ProcessManagerConfig {
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  workerAdapter: WorkerAdapter;
  resolveProgram?: (path: string) => Promise<ArrayBuffer | null>;
}

export interface SpawnOptions {
  ppid?: number;
  env?: string[];
  argv?: string[];
  cwd?: string;
  programBytes?: ArrayBuffer;
}

export interface WaitResult {
  pid: number;
  status: number;
}

export class ProcessManager {
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 1;
  private config: ProcessManagerConfig;
  private nextPipeHandle = 1000; // Start at 1000 to avoid conflicts with file handles
  private sharedPipes = new Map<number, SharedPipeBuffer>();
  private sharedLockTable: SharedLockTable;

  constructor(config: ProcessManagerConfig) {
    this.config = config;
    this.sharedLockTable = SharedLockTable.create();
  }

  async spawn(options?: SpawnOptions): Promise<number> {
    const pid = this.nextPid++;
    const ppid = options?.ppid ?? 0;

    const signalWakeSab = new SharedArrayBuffer(8);
    const forkSab = new SharedArrayBuffer(8);
    const waitpidSab = new SharedArrayBuffer(12); // [flag, resultPid, status]

    const initData: WorkerInitMessage = {
      type: "init",
      pid,
      ppid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      env: options?.env,
      argv: options?.argv,
      cwd: options?.cwd,
      signalWakeSab,
      lockTableSab: this.sharedLockTable.getBuffer(),
      forkSab,
      waitpidSab,
      programBytes: options?.programBytes,
    };

    const worker = this.config.workerAdapter.createWorker(initData);

    const info: ProcessInfo = {
      pid,
      ppid,
      pgid: pid,
      sid: pid,
      worker,
      state: "starting",
      signalWakeSab,
      forkSab,
      waitpidSab,
      programBytes: options?.programBytes,
    };

    this.processes.set(pid, info);

    const cleanup = () => {
      this.processes.delete(pid);
      this.sharedLockTable.removeLocksByPid(pid);
      worker.terminate().catch(() => {});
    };

    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Process ${pid} timed out during initialization`));
      }, 10_000);

      worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        switch (m.type) {
          case "ready":
            if (info.state === "starting") {
              clearTimeout(timeout);
              info.state = "running";
              resolve(pid);
            }
            break;
          case "exit":
            if (info.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(`Worker exited with status ${m.status}`));
            } else {
              if (info.alarmTimer) {
                clearTimeout(info.alarmTimer);
                info.alarmTimer = undefined;
              }
              this.sharedLockTable.removeLocksByPid(pid);
              info.state = "zombie";
              info.exitStatus = m.status;
              // POSIX: deliver SIGCHLD to parent when child exits
              if (info.ppid > 0) {
                try { this.deliverSignal(info.ppid, 17); } catch { /* parent may have exited */ }
              }
            }
            break;
          case "error":
            if (info.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(m.message));
            }
            break;
          case "kill_request":
            try {
              this.deliverSignal(m.pid, m.signal);
            } catch {
              // Target doesn't exist — ESRCH, but caller already returned 0
            }
            break;
          case "exec_request": {
            // Load binary — resolve program or use same binary.
            if (info.alarmTimer) {
              clearTimeout(info.alarmTimer);
              info.alarmTimer = undefined;
            }
            (async () => {
              const wasmBytes = this.config.wasmBytes;
              const resolvedProgram = this.config.resolveProgram
                ? await this.config.resolveProgram(m.path)
                : info.programBytes;
              info.worker.postMessage(
                { type: "exec_reply", wasmBytes: wasmBytes.slice(0), programBytes: resolvedProgram ? resolvedProgram.slice(0) : undefined },
              );
            })();
            break;
          }
          case "alarm_set": {
            const alarmInfo = this.processes.get(m.pid);
            if (alarmInfo && alarmInfo.state === "running") {
              if (alarmInfo.alarmTimer) {
                clearTimeout(alarmInfo.alarmTimer);
                alarmInfo.alarmTimer = undefined;
              }
              if (m.seconds > 0) {
                alarmInfo.alarmTimer = setTimeout(() => {
                  alarmInfo.alarmTimer = undefined;
                  try {
                    this.deliverSignal(m.pid, 14); // SIGALRM
                  } catch { /* process may have exited */ }
                }, m.seconds * 1000);
              }
            }
            break;
          }
          case "fork_request": {
            { const fm = m as import("./worker-protocol").ForkRequestMessage; this.handleForkRequest(fm.pid, fm.forkSab, fm.forkState, fm.pipeSabs, fm.asyncifyData); }
            break;
          }
          case "waitpid_request": {
            const wm = m as import("./worker-protocol").WaitpidRequestMessage;
            this.handleWaitpidRequest(wm.targetPid, wm.options, wm.waitpidSab);
            break;
          }
          case "clone_request": {
            const cm = m as import("./worker-protocol").CloneRequestMessage;
            this.handleCloneRequest(cm.pid, cm.fnPtr, cm.argPtr, cm.stackPtr, cm.tlsPtr, cm.ctidPtr, cm.cloneSab, cm.memory, info);
            break;
          }
          case "thread_exit":
            // Thread exited — no special cleanup needed for now
            break;
        }
      });

      worker.on("error", (err: Error) => {
        if (info.state === "starting") {
          clearTimeout(timeout);
          cleanup();
          reject(err);
        }
      });

      worker.on("exit", (code: number) => {
        if (info.state === "starting") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Worker exited with code ${code} during init`));
        }
      });
    });
  }

  getProcess(pid: number): ProcessInfo | undefined {
    return this.processes.get(pid);
  }

  getProcessCount(): number {
    return this.processes.size;
  }

  async fork(parentPid: number): Promise<number> {
    const parentInfo = this.processes.get(parentPid);
    if (!parentInfo || parentInfo.state !== "running") {
      throw new Error(`Cannot fork process ${parentPid}: not running`);
    }

    // Request fork state from parent
    const forkState = await this.requestForkState(parentInfo);

    // Allocate child PID
    const childPid = this.nextPid++;

    const signalWakeSab = new SharedArrayBuffer(8);
    const childForkSab = new SharedArrayBuffer(8);

    // Create child worker with fork state
    const initData: WorkerInitMessage = {
      type: "init",
      pid: childPid,
      ppid: parentPid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      forkState,
      signalWakeSab,
      lockTableSab: this.sharedLockTable.getBuffer(),
      forkSab: childForkSab,
      programBytes: parentInfo.programBytes,
    };

    const worker = this.config.workerAdapter.createWorker(initData);
    const childInfo: ProcessInfo = {
      pid: childPid,
      ppid: parentPid,
      pgid: parentInfo.pgid,
      sid: parentInfo.sid,
      worker,
      state: "starting",
      signalWakeSab,
      forkSab: childForkSab,
      programBytes: parentInfo.programBytes,
    };
    this.processes.set(childPid, childInfo);

    const cleanup = () => {
      this.processes.delete(childPid);
      this.sharedLockTable.removeLocksByPid(childPid);
      worker.terminate().catch(() => {});
    };

    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Forked process ${childPid} timed out during initialization`,
          ),
        );
      }, 10_000);

      worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        switch (m.type) {
          case "ready":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              childInfo.state = "running";

              // Detect pipe OFDs from fork state and convert to shared pipes.
              // Pipe OFDs are grouped by their underlying pipe (same host_handle).
              // One SharedPipeBuffer is created per pipe, shared by both endpoints.
              // Each OFD gets its own handle so close can identify read vs write end.
              try {
                const pipeGroups = this.parsePipeGroupsFromForkState(forkState);
                for (const group of pipeGroups) {
                  const sharedPipe = SharedPipeBuffer.create();
                  const sab = sharedPipe.getBuffer();

                  // Each OFD gets its own handle pointing to the same SharedPipeBuffer
                  for (const ofd of group.ofds) {
                    const handle = this.nextPipeHandle++;
                    this.sharedPipes.set(handle, sharedPipe);
                    const end = ofd.isRead ? "read" as const : "write" as const;

                    // Register with both workers (same SAB, per-OFD handle + end type)
                    parentInfo.worker.postMessage(
                      { type: "register_pipe", handle, buffer: sab, end },
                    );
                    childInfo.worker.postMessage(
                      { type: "register_pipe", handle, buffer: sab, end },
                    );

                    // Convert this OFD in both kernels
                    parentInfo.worker.postMessage(
                      { type: "convert_pipe", ofdIndex: ofd.ofdIndex, newHandle: handle },
                    );
                    childInfo.worker.postMessage(
                      { type: "convert_pipe", ofdIndex: ofd.ofdIndex, newHandle: handle },
                    );
                  }
                }
              } catch {
                // If parsing fails, skip pipe conversion (no pipes to convert)
              }

              resolve(childPid);
            }
            break;
          case "exit":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(`Forked worker exited with status ${m.status}`));
            } else {
              if (childInfo.alarmTimer) {
                clearTimeout(childInfo.alarmTimer);
                childInfo.alarmTimer = undefined;
              }
              this.sharedLockTable.removeLocksByPid(childPid);
              childInfo.state = "zombie";
              childInfo.exitStatus = m.status;
              // POSIX: deliver SIGCHLD to parent when child exits
              if (childInfo.ppid > 0) {
                try { this.deliverSignal(childInfo.ppid, 17); } catch { /* parent may have exited */ }
              }
            }
            break;
          case "error":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(m.message));
            }
            break;
          case "kill_request":
            try {
              this.deliverSignal(m.pid, m.signal);
            } catch {
              // Target doesn't exist — ESRCH, but caller already returned 0
            }
            break;
          case "exec_request": {
            // Load binary — resolve program or use same binary.
            if (childInfo.alarmTimer) {
              clearTimeout(childInfo.alarmTimer);
              childInfo.alarmTimer = undefined;
            }
            (async () => {
              const wasmBytes = this.config.wasmBytes;
              const resolvedProgram = this.config.resolveProgram
                ? await this.config.resolveProgram(m.path)
                : childInfo.programBytes;
              childInfo.worker.postMessage(
                { type: "exec_reply", wasmBytes: wasmBytes.slice(0), programBytes: resolvedProgram ? resolvedProgram.slice(0) : undefined },
              );
            })();
            break;
          }
          case "alarm_set": {
            const alarmInfo = this.processes.get(m.pid);
            if (alarmInfo && alarmInfo.state === "running") {
              if (alarmInfo.alarmTimer) {
                clearTimeout(alarmInfo.alarmTimer);
                alarmInfo.alarmTimer = undefined;
              }
              if (m.seconds > 0) {
                alarmInfo.alarmTimer = setTimeout(() => {
                  alarmInfo.alarmTimer = undefined;
                  try {
                    this.deliverSignal(m.pid, 14); // SIGALRM
                  } catch { /* process may have exited */ }
                }, m.seconds * 1000);
              }
            }
            break;
          }
          case "fork_request": {
            { const fm = m as import("./worker-protocol").ForkRequestMessage; this.handleForkRequest(fm.pid, fm.forkSab, fm.forkState, fm.pipeSabs, fm.asyncifyData); }
            break;
          }
          case "waitpid_request": {
            const wm = m as import("./worker-protocol").WaitpidRequestMessage;
            this.handleWaitpidRequest(wm.targetPid, wm.options, wm.waitpidSab);
            break;
          }
        }
      });

      worker.on("error", (err: Error) => {
        if (childInfo.state === "starting") {
          clearTimeout(timeout);
          cleanup();
          reject(err);
        }
      });

      worker.on("exit", (code: number) => {
        if (childInfo.state === "starting") {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Forked worker exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Parse pipe OFDs from fork state binary, grouped by underlying pipe.
   * Pipe OFDs sharing the same host_handle belong to the same pipe
   * (read end and write end both have host_handle = -(pipe_idx + 1)).
   * Returns one entry per unique pipe with per-OFD info (index + read/write end).
   */
  private parsePipeGroupsFromForkState(forkState: ArrayBuffer): { ofds: { ofdIndex: number; isRead: boolean }[] }[] {
    const view = new DataView(forkState);
    let offset = 12; // skip header (magic + version + total_size)
    offset += 32;    // skip scalars (8 u32s)

    // Skip signal state
    offset += 8; // blocked u64
    const handlerCount = view.getUint32(offset, true);
    offset += 4;
    offset += handlerCount * 8; // skip handlers

    // Skip FD table
    const _maxFds = view.getUint32(offset, true);
    offset += 4;
    const fdCount = view.getUint32(offset, true);
    offset += 4;
    offset += fdCount * 12; // skip fd entries (fd_num + ofd_index + fd_flags)

    // Read OFD table — group pipe OFDs by host_handle
    const ofdCount = view.getUint32(offset, true);
    offset += 4;

    const O_ACCMODE = 3;
    const pipesByHandle = new Map<bigint, { ofdIndex: number; isRead: boolean }[]>();
    for (let i = 0; i < ofdCount; i++) {
      const index = view.getUint32(offset, true);
      const fileType = view.getUint32(offset + 4, true);
      const statusFlags = view.getUint32(offset + 8, true);
      const hostHandle = view.getBigInt64(offset + 12, true);
      offset += 32; // index(4) + fileType(4) + statusFlags(4) + host_handle(8) + offset(8) + ref_count(4) = 32

      if (fileType === 2) { // Pipe
        const ofd = { ofdIndex: index, isRead: (statusFlags & O_ACCMODE) === 0 };
        const existing = pipesByHandle.get(hostHandle);
        if (existing) {
          existing.push(ofd);
        } else {
          pipesByHandle.set(hostHandle, [ofd]);
        }
      }
    }

    return Array.from(pipesByHandle.values()).map(ofds => ({ ofds }));
  }

  private requestForkState(parentInfo: ProcessInfo): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        parentInfo.worker.off("message", handler);
        reject(
          new Error(
            `Fork state request timed out for process ${parentInfo.pid}`,
          ),
        );
      }, 10_000);

      const handler = (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "fork_state" && m.pid === parentInfo.pid) {
          clearTimeout(timeout);
          parentInfo.worker.off("message", handler);
          resolve(m.data);
        }
      };

      parentInfo.worker.on("message", handler);
      parentInfo.worker.postMessage({ type: "get_fork_state" });
    });
  }

  async waitpid(targetPid: number, options: number = 0): Promise<WaitResult> {
    const WNOHANG = 1;

    const info = this.processes.get(targetPid);
    if (!info) {
      throw new Error(`No such process: ${targetPid}`);
    }

    // Already exited? Reap immediately.
    if (info.state === "zombie") {
      const status = info.exitStatus ?? 0;
      this.processes.delete(targetPid);
      return { pid: targetPid, status };
    }

    // WNOHANG: return immediately if not exited
    if (options & WNOHANG) {
      return { pid: 0, status: 0 };
    }

    // Wait for exit
    return new Promise<WaitResult>((resolve) => {
      info.worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exit" && m.pid === targetPid) {
          this.processes.delete(targetPid);
          resolve({ pid: targetPid, status: m.status });
        }
      });

      info.worker.on("exit", (code: number) => {
        this.processes.delete(targetPid);
        resolve({ pid: targetPid, status: code });
      });
    });
  }

  async exec(pid: number, wasmBytes: ArrayBuffer): Promise<void> {
    const info = this.processes.get(pid);
    if (!info || info.state !== "running") {
      throw new Error(`Cannot exec process ${pid}: not running`);
    }

    info.worker.postMessage({ type: "exec_reply", wasmBytes: wasmBytes.slice(0) });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        info.worker.off("message", handler);
        reject(new Error(`Exec timed out for process ${pid}`));
      }, 10_000);

      const handler = (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "exec_complete" && m.pid === pid) {
          clearTimeout(timeout);
          info.worker.off("message", handler);
          resolve();
        } else if (m.type === "error" && m.pid === pid) {
          clearTimeout(timeout);
          info.worker.off("message", handler);
          reject(new Error(m.message));
        }
      };

      info.worker.on("message", handler);
    });
  }

  deliverSignal(targetPid: number, signal: number): void {
    const info = this.processes.get(targetPid);
    if (!info || info.state === "zombie") {
      throw new Error(`No such process: ${targetPid}`);
    }
    // sig=0 is a POSIX existence check — no actual signal delivery
    if (signal === 0) return;

    // Normal delivery via message
    info.worker.postMessage({ type: "deliver_signal", signal });

    // Also wake via shared memory (for sigsuspend)
    if (info.signalWakeSab) {
      const view = new Int32Array(info.signalWakeSab);
      Atomics.store(view, 1, signal);
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    }
  }

  /**
   * Handle a guest-initiated fork request. Creates child worker from
   * pre-serialized fork state (parent worker is blocked on Atomics.wait
   * so we can't request state from it). Signals result via forkSab.
   */
  private handleForkRequest(
    parentPid: number,
    forkSab: SharedArrayBuffer,
    forkState: ArrayBuffer,
    pipeSabs?: { handle: number; sab: SharedArrayBuffer; end: "read" | "write" }[],
    asyncifyData?: { memorySnapshot: ArrayBuffer; asyncifyData: ArrayBuffer; asyncifyDataAddr: number },
  ): void {
    const view = new Int32Array(forkSab);
    this.forkWithState(parentPid, forkState, pipeSabs, asyncifyData).then((childPid) => {
      Atomics.store(view, 1, childPid);
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    }).catch(() => {
      Atomics.store(view, 1, -12); // -ENOMEM
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    });
  }

  /**
   * Handle clone_request: spawn a new thread worker that shares the
   * parent's Memory but has its own Wasm instances. The thread worker
   * sets the thread pointer, calls fn(arg) via the function table,
   * then writes 0 to *ctid and wakes joiners.
   */
  private handleCloneRequest(
    parentPid: number,
    fnPtr: number,
    argPtr: number,
    stackPtr: number,
    tlsPtr: number,
    ctidPtr: number,
    cloneSab: SharedArrayBuffer,
    memory: WebAssembly.Memory,
    parentInfo: ProcessInfo,
  ): void {
    const view = new Int32Array(cloneSab);
    const tid = this.nextPid++;

    const threadInitData: ThreadInitMessage = {
      type: "thread_init",
      tid,
      wasmBytes: this.config.wasmBytes.slice(0),
      kernelConfig: this.config.kernelConfig,
      programBytes: parentInfo.programBytes?.slice(0),
      fnPtr,
      argPtr,
      stackPtr,
      tlsPtr,
      ctidPtr,
      lockTableSab: this.sharedLockTable.getBuffer(),
      memory,
    };

    // Spawn thread worker
    try {
      const threadWorker = this.config.workerAdapter.createWorker(threadInitData);
      // Listen for thread exit
      threadWorker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "thread_exit") {
          // Thread done — nothing to clean up for now
        }
      });

      // Signal parent with the TID
      Atomics.store(view, 1, tid);
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    } catch {
      Atomics.store(view, 1, -12); // -ENOMEM
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    }
  }

  /**
   * Fork using pre-serialized state (for guest-initiated fork where
   * the parent worker is blocked and can't respond to get_fork_state).
   */
  private async forkWithState(
    parentPid: number,
    forkState: ArrayBuffer,
    pipeSabs?: { handle: number; sab: SharedArrayBuffer; end: "read" | "write" }[],
    asyncifyData?: { memorySnapshot: ArrayBuffer; asyncifyData: ArrayBuffer; asyncifyDataAddr: number },
  ): Promise<number> {
    const parentInfo = this.processes.get(parentPid);
    if (!parentInfo) {
      throw new Error(`Cannot fork process ${parentPid}: not found`);
    }

    const childPid = this.nextPid++;
    const signalWakeSab = new SharedArrayBuffer(8);
    const childForkSab = new SharedArrayBuffer(8);
    const childWaitpidSab = new SharedArrayBuffer(12);

    const initData: WorkerInitMessage = {
      type: "init",
      pid: childPid,
      ppid: parentPid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      forkState: asyncifyData ? undefined : forkState,
      signalWakeSab,
      lockTableSab: this.sharedLockTable.getBuffer(),
      forkSab: childForkSab,
      waitpidSab: childWaitpidSab,
      programBytes: parentInfo.programBytes,
      asyncifyResume: asyncifyData ? {
        memorySnapshot: asyncifyData.memorySnapshot,
        asyncifyData: asyncifyData.asyncifyData,
        asyncifyDataAddr: asyncifyData.asyncifyDataAddr,
      } : undefined,
    };

    const worker = this.config.workerAdapter.createWorker(initData);
    const childInfo: ProcessInfo = {
      pid: childPid,
      ppid: parentPid,
      pgid: parentInfo.pgid,
      sid: parentInfo.sid,
      worker,
      state: "starting",
      signalWakeSab,
      forkSab: childForkSab,
      waitpidSab: childWaitpidSab,
      programBytes: parentInfo.programBytes,
    };
    this.processes.set(childPid, childInfo);

    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.processes.delete(childPid);
        this.sharedLockTable.removeLocksByPid(childPid);
        worker.terminate().catch(() => {});
        reject(new Error(`Forked process ${childPid} timed out during initialization`));
      }, 10_000);

      worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        switch (m.type) {
          case "ready":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              childInfo.state = "running";

              // Register parent's shared pipes with child worker so cross-process
              // pipe I/O works. The parent already converted its pipes before fork.
              if (pipeSabs && pipeSabs.length > 0) {
                for (const p of pipeSabs) {
                  worker.postMessage({ type: "register_pipe", handle: p.handle, buffer: p.sab, end: p.end });
                }
              }

              resolve(childPid);
            }
            break;
          case "exit":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              this.processes.delete(childPid);
              this.sharedLockTable.removeLocksByPid(childPid);
              worker.terminate().catch(() => {});
              reject(new Error(`Forked worker exited with status ${m.status}`));
            } else {
              if (childInfo.alarmTimer) {
                clearTimeout(childInfo.alarmTimer);
                childInfo.alarmTimer = undefined;
              }
              this.sharedLockTable.removeLocksByPid(childPid);
              childInfo.state = "zombie";
              childInfo.exitStatus = m.status;
              if (childInfo.ppid > 0) {
                try { this.deliverSignal(childInfo.ppid, 17); } catch { /* parent may have exited */ }
              }
            }
            break;
          case "error":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              this.processes.delete(childPid);
              this.sharedLockTable.removeLocksByPid(childPid);
              worker.terminate().catch(() => {});
              reject(new Error(m.message));
            }
            break;
          case "kill_request":
            try { this.deliverSignal(m.pid, m.signal); } catch { /* target doesn't exist */ }
            break;
          case "exec_request": {
            if (childInfo.alarmTimer) {
              clearTimeout(childInfo.alarmTimer);
              childInfo.alarmTimer = undefined;
            }
            (async () => {
              const wasmBytes = this.config.wasmBytes;
              const resolvedProgram = this.config.resolveProgram
                ? await this.config.resolveProgram(m.path)
                : childInfo.programBytes;
              childInfo.worker.postMessage(
                { type: "exec_reply", wasmBytes: wasmBytes.slice(0), programBytes: resolvedProgram ? resolvedProgram.slice(0) : undefined },
              );
            })();
            break;
          }
          case "alarm_set": {
            const alarmInfo = this.processes.get(m.pid);
            if (alarmInfo && alarmInfo.state === "running") {
              if (alarmInfo.alarmTimer) {
                clearTimeout(alarmInfo.alarmTimer);
                alarmInfo.alarmTimer = undefined;
              }
              if (m.seconds > 0) {
                alarmInfo.alarmTimer = setTimeout(() => {
                  alarmInfo.alarmTimer = undefined;
                  try { this.deliverSignal(m.pid, 14); } catch { /* process may have exited */ }
                }, m.seconds * 1000);
              }
            }
            break;
          }
          case "fork_request": {
            { const fm = m as import("./worker-protocol").ForkRequestMessage; this.handleForkRequest(fm.pid, fm.forkSab, fm.forkState, fm.pipeSabs, fm.asyncifyData); }
            break;
          }
          case "waitpid_request": {
            const wm = m as import("./worker-protocol").WaitpidRequestMessage;
            this.handleWaitpidRequest(wm.targetPid, wm.options, wm.waitpidSab);
            break;
          }
        }
      });

      worker.on("error", (err: Error) => {
        if (childInfo.state === "starting") {
          clearTimeout(timeout);
          this.processes.delete(childPid);
          this.sharedLockTable.removeLocksByPid(childPid);
          worker.terminate().catch(() => {});
          reject(err);
        }
      });

      worker.on("exit", (code: number) => {
        if (childInfo.state === "starting") {
          clearTimeout(timeout);
          this.processes.delete(childPid);
          this.sharedLockTable.removeLocksByPid(childPid);
          reject(new Error(`Forked worker exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Handle a guest-initiated waitpid request. Waits for the target child
   * to exit and signals the result back via the caller's waitpidSab.
   * waitpidSab layout: Int32Array(3) [flag, resultPid, status]
   */
  private handleWaitpidRequest(targetPid: number, options: number, waitpidSab: SharedArrayBuffer): void {
    const view = new Int32Array(waitpidSab);
    const WNOHANG = 1;

    const signal = (pid: number, status: number) => {
      Atomics.store(view, 1, pid);
      Atomics.store(view, 2, status);
      Atomics.store(view, 0, 1);
      Atomics.notify(view, 0);
    };

    const info = this.processes.get(targetPid);
    if (!info) {
      signal(-10, 0); // -ECHILD
      return;
    }

    if (info.state === "zombie") {
      const status = info.exitStatus ?? 0;
      // Encode as wait status: (exitCode << 8) for normal exit
      signal(targetPid, (status & 0xff) << 8);
      this.processes.delete(targetPid);
      return;
    }

    if (options & WNOHANG) {
      signal(0, 0);
      return;
    }

    // Wait for child exit
    info.worker.on("message", (msg: unknown) => {
      const m = msg as WorkerToHostMessage;
      if (m.type === "exit") {
        const status = m.status;
        signal(targetPid, (status & 0xff) << 8);
        this.processes.delete(targetPid);
      }
    });

    info.worker.on("exit", () => {
      if (this.processes.has(targetPid)) {
        signal(targetPid, 0);
        this.processes.delete(targetPid);
      }
    });
  }

  async terminate(pid: number): Promise<void> {
    const info = this.processes.get(pid);
    if (!info) return;
    this.sharedLockTable.removeLocksByPid(pid);
    await info.worker.terminate();
    this.processes.delete(pid);
  }
}
