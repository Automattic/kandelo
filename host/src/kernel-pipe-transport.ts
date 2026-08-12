/**
 * Host-neutral injected-connection boundary used by in-kernel protocol
 * clients. BrowserKernel and NodeKernelHost both implement this interface.
 */
export interface KernelPipeTransport {
  pickListenerTarget(
    port: number,
  ): Promise<{ pid: number; fd: number } | null>;
  injectConnection(
    pid: number,
    listenerFd: number,
    peerAddr?: [number, number, number, number],
    peerPort?: number,
  ): Promise<number>;
  pipeWrite(pid: number, pipeIdx: number, data: Uint8Array): Promise<number>;
  pipeRead(pid: number, pipeIdx: number): Promise<Uint8Array | null>;
  pipeCloseWrite(pid: number, pipeIdx: number): void;
  pipeCloseRead(pid: number, pipeIdx: number): void;
  pipeIsWriteOpen(pid: number, pipeIdx: number): Promise<boolean>;
  wakeBlockedReaders(pipeIdx: number): void;
  wakeBlockedWriters(pipeIdx: number): void;
}

export type UninitializedKernelPipeOperation =
  | "pick-listener"
  | "read"
  | "inject"
  | "write"
  | "is-write-open";

/**
 * Fail-closed values for messages that arrive before the kernel worker has
 * completed initialization. Keeping these host-neutral prevents Node and the
 * browser from diverging or dereferencing an unassigned kernel boundary.
 */
export function uninitializedKernelPipeResult(
  operation: UninitializedKernelPipeOperation,
): null | number | boolean {
  switch (operation) {
    case "pick-listener":
    case "read":
      return null;
    case "inject":
    case "write":
      return -1;
    case "is-write-open":
      return false;
  }
}
