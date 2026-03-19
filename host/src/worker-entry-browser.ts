import { workerMain, threadWorkerMain } from "./worker-main";
import type { WorkerInitMessage, ThreadInitMessage } from "./worker-protocol";
import type { PlatformIO } from "./types";
import { VirtualPlatformIO } from "./vfs/vfs";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { DeviceFileSystem } from "./vfs/device-fs";
import { BrowserTimeProvider } from "./vfs/time";
import type { MountConfig } from "./vfs/types";

function createIO(initData: WorkerInitMessage): PlatformIO {
  if (!initData.mounts || initData.mounts.length === 0) {
    throw new Error("Browser worker requires at least one memory mount");
  }
  const unsupported = initData.mounts.filter(m => m.type !== "memory");
  if (unsupported.length > 0) {
    throw new Error(
      `Browser worker does not support mount types: ${unsupported.map(m => `${m.type} at ${m.mountPoint}`).join(", ")}`,
    );
  }
  const backends: MountConfig[] = initData.mounts.map(m => ({
      mountPoint: m.mountPoint,
      backend: m.initialize
        ? MemoryFileSystem.create(m.sharedBuffer!)
        : MemoryFileSystem.fromExisting(m.sharedBuffer!),
    }));
  // Auto-mount /dev with virtual device files (null, zero, urandom, random)
  backends.push({ mountPoint: "/dev", backend: new DeviceFileSystem() });
  return new VirtualPlatformIO(backends, new BrowserTimeProvider());
}

// Web Worker / Service Worker global scope
const sw = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

sw.onmessage = (e: MessageEvent) => {
  const data = e.data as { type: string };
  const port = {
    postMessage: (msg: unknown, transfer?: unknown[]) =>
      sw.postMessage(msg, transfer as Transferable[]),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") {
        sw.onmessage = (ev: MessageEvent) => handler(ev.data);
      }
    },
  };
  if (data.type === "thread_init") {
    threadWorkerMain(port, e.data as ThreadInitMessage, createIO);
  } else {
    workerMain(port, e.data as WorkerInitMessage, createIO);
  }
};
