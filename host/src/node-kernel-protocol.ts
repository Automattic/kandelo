/**
 * Message protocol for Node.js main thread ↔ kernel worker_thread communication.
 *
 * Mirrors the browser's kernel-worker-protocol.ts but adapted for Node.js:
 * - No SharedArrayBuffer VFS (Node uses real filesystem via NodePlatformIO)
 * - No worker entry URLs (Node uses NodeWorkerAdapter)
 * - No pipe/inject/bridge operations (TCP bridging is automatic via NodePlatformIO)
 */

// ── Main Thread → Kernel Worker ──

export interface InitMessage {
  type: "init";
  kernelWasmBytes: ArrayBuffer;
  config: {
    maxWorkers: number;
    maxPages?: number;
    dataBufferSize?: number;
    useSharedMemory?: boolean;
  };
  /** Virtual path → host filesystem path for exec resolution */
  execPrograms?: Record<string, string>;
  /**
   * Bytes of `host/wasm/rootfs.vfs`, read on the main thread and forwarded
   * to the worker. When present, the worker materialises the default mount
   * spec (rootfs at `/`, scratch dirs at `/tmp` etc.) and constructs a
   * `VirtualPlatformIO`. Absent → worker falls back to `NodePlatformIO`
   * (custom-io / legacy path).
   */
  rootfsImage?: ArrayBuffer;
}

export interface SpawnMessage {
  type: "spawn";
  requestId: number;
  programBytes: ArrayBuffer;
  argv: string[];
  env?: string[];
  cwd?: string;
  pty?: boolean;
  stdin?: Uint8Array;
  /** Limit heap growth to protect thread channel pages */
  maxAddr?: number;
}

export interface AppendStdinDataMessage {
  type: "append_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface SetStdinDataMessage {
  type: "set_stdin_data";
  pid: number;
  data: Uint8Array;
}

export interface PtyWriteMessage {
  type: "pty_write";
  pid: number;
  data: Uint8Array;
}

export interface PtyResizeMessage {
  type: "pty_resize";
  pid: number;
  rows: number;
  cols: number;
}

export interface TerminateProcessMessage {
  type: "terminate_process";
  requestId: number;
  pid: number;
  status: number;
}

export interface DestroyMessage {
  type: "destroy";
  requestId: number;
}

export interface ResolveExecResponseMessage {
  type: "resolve_exec_response";
  requestId: number;
  programBytes: ArrayBuffer | null;
}

export type MainToKernelMessage =
  | InitMessage
  | SpawnMessage
  | AppendStdinDataMessage
  | SetStdinDataMessage
  | PtyWriteMessage
  | PtyResizeMessage
  | TerminateProcessMessage
  | DestroyMessage
  | ResolveExecResponseMessage;

// ── Kernel Worker → Main Thread ──

export interface ReadyMessage {
  type: "ready";
}

export interface ResponseMessage {
  type: "response";
  requestId: number;
  result: unknown;
  error?: string;
}

export interface ExitMessage {
  type: "exit";
  pid: number;
  status: number;
}

export interface StdoutMessage {
  type: "stdout";
  pid: number;
  data: Uint8Array;
}

export interface StderrMessage {
  type: "stderr";
  pid: number;
  data: Uint8Array;
}

export interface PtyOutputMessage {
  type: "pty_output";
  pid: number;
  data: Uint8Array;
}

export interface ResolveExecRequestMessage {
  type: "resolve_exec";
  requestId: number;
  path: string;
}

export type KernelToMainMessage =
  | ReadyMessage
  | ResponseMessage
  | ExitMessage
  | StdoutMessage
  | StderrMessage
  | PtyOutputMessage
  | ResolveExecRequestMessage;
