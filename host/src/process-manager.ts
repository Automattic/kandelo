import type { WorkerAdapter, WorkerHandle } from "./worker-adapter";
import type { KernelConfig } from "./types";
import type {
  WorkerInitMessage,
  WorkerToHostMessage,
} from "./worker-protocol";

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

export class ProcessManager {
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 1;
  private config: ProcessManagerConfig;

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

  private requestForkState(parentInfo: ProcessInfo): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Fork state request timed out for process ${parentInfo.pid}`,
          ),
        );
      }, 10_000);

      parentInfo.worker.on("message", (msg: unknown) => {
        const m = msg as WorkerToHostMessage;
        if (m.type === "fork_state" && m.pid === parentInfo.pid) {
          clearTimeout(timeout);
          resolve(m.data);
        }
      });

      parentInfo.worker.postMessage({ type: "get_fork_state" });
    });
  }

  async terminate(pid: number): Promise<void> {
    const info = this.processes.get(pid);
    if (!info) return;
    await info.worker.terminate();
    this.processes.delete(pid);
  }
}
