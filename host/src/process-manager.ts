import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
import type { KernelConfig } from "./types";
import type {
  WorkerInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";
import { SharedPipeBuffer } from "./shared-pipe-buffer";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  worker: WorkerHandle;
  state: "starting" | "running" | "zombie";
  exitStatus?: number;
}

export interface ProcessManagerConfig {
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  workerAdapter: WorkerAdapter;
}

export interface SpawnOptions {
  ppid?: number;
  env?: string[];
  cwd?: string;
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

  constructor(config: ProcessManagerConfig) {
    this.config = config;
  }

  async spawn(options?: SpawnOptions): Promise<number> {
    const pid = this.nextPid++;
    const ppid = options?.ppid ?? 0;

    const initData: WorkerInitMessage = {
      type: "init",
      pid,
      ppid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      env: options?.env,
      cwd: options?.cwd,
    };

    const worker = this.config.workerAdapter.createWorker(initData);

    const info: ProcessInfo = {
      pid,
      ppid,
      pgid: pid,
      sid: pid,
      worker,
      state: "starting",
    };

    this.processes.set(pid, info);

    const cleanup = () => {
      this.processes.delete(pid);
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
              info.state = "zombie";
              info.exitStatus = m.status;
            }
            break;
          case "error":
            if (info.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(m.message));
            }
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

    // Create child worker with fork state
    const initData: WorkerInitMessage = {
      type: "init",
      pid: childPid,
      ppid: parentPid,
      wasmBytes: this.config.wasmBytes,
      kernelConfig: this.config.kernelConfig,
      forkState,
    };

    const worker = this.config.workerAdapter.createWorker(initData);
    const childInfo: ProcessInfo = {
      pid: childPid,
      ppid: parentPid,
      pgid: parentInfo.pgid,
      sid: parentInfo.sid,
      worker,
      state: "starting",
    };
    this.processes.set(childPid, childInfo);

    const cleanup = () => {
      this.processes.delete(childPid);
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
              childInfo.state = "zombie";
              childInfo.exitStatus = m.status;
            }
            break;
          case "error":
            if (childInfo.state === "starting") {
              clearTimeout(timeout);
              cleanup();
              reject(new Error(m.message));
            }
            break;
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

  async terminate(pid: number): Promise<void> {
    const info = this.processes.get(pid);
    if (!info) return;
    await info.worker.terminate();
    this.processes.delete(pid);
  }
}
