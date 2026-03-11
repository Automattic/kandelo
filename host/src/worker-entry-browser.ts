import { workerMain } from "./worker-main";
import type { WorkerInitMessage } from "./worker-protocol";
import type { PlatformIO } from "./types";
import { VirtualPlatformIO } from "./vfs/vfs";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { BrowserTimeProvider } from "./vfs/time";

function createIO(initData: WorkerInitMessage): PlatformIO {
  if (!initData.mounts || initData.mounts.length === 0) {
    throw new Error("Browser worker requires at least one memory mount");
  }
  const backends = initData.mounts
    .filter(m => m.type === "memory")
    .map(m => ({
      mountPoint: m.mountPoint,
      backend: m.initialize
        ? MemoryFileSystem.create(m.sharedBuffer!)
        : MemoryFileSystem.fromExisting(m.sharedBuffer!),
    }));
  return new VirtualPlatformIO(backends, new BrowserTimeProvider());
}

// Web Worker / Service Worker global scope
const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

sw.onmessage = (e: MessageEvent) => {
  const initData = e.data as WorkerInitMessage;
  const port = {
    postMessage: (msg: unknown, transfer?: unknown[]) =>
      sw.postMessage(msg, transfer as Transferable[]),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") {
        sw.onmessage = (ev: MessageEvent) => handler(ev.data);
      }
    },
  };
  workerMain(port, initData, createIO);
};
