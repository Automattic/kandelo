import type { KernelConfig } from "./types";

// --- Host → Worker messages ---

export type HostToWorkerMessage =
  | WorkerInitMessage
  | WorkerTerminateMessage
  | GetForkStateMessage
  | RegisterPipeMessage
  | ConvertPipeMessage;

export interface GetForkStateMessage {
  type: "get_fork_state";
}

export interface RegisterPipeMessage {
  type: "register_pipe";
  handle: number;
  buffer: SharedArrayBuffer;
  end: "read" | "write";
}

export interface ConvertPipeMessage {
  type: "convert_pipe";
  ofdIndex: number;
  newHandle: number;
}

export interface WorkerInitMessage {
  type: "init";
  pid: number;
  ppid: number;
  wasmBytes: ArrayBuffer;
  kernelConfig: KernelConfig;
  env?: string[];
  cwd?: string;
  forkState?: ArrayBuffer;
}

export interface WorkerTerminateMessage {
  type: "terminate";
}

// --- Worker → Host messages ---

export type WorkerToHostMessage =
  | WorkerReadyMessage
  | WorkerExitMessage
  | WorkerErrorMessage
  | ForkStateMessage;

export interface WorkerReadyMessage {
  type: "ready";
  pid: number;
}

export interface WorkerExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface WorkerErrorMessage {
  type: "error";
  pid: number;
  message: string;
}

export interface ForkStateMessage {
  type: "fork_state";
  pid: number;
  data: ArrayBuffer;
}
