import { parentPort, workerData } from "node:worker_threads";
import { workerMain, threadWorkerMain } from "./worker-main";
import type { WorkerInitMessage, ThreadInitMessage } from "./worker-protocol";
import type { PlatformIO } from "./types";
import { NodePlatformIO } from "./platform/node";
import { VirtualPlatformIO } from "./vfs/vfs";
import { HostFileSystem } from "./vfs/host-fs";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { NodeTimeProvider } from "./vfs/time";

function createIO(initData: WorkerInitMessage): PlatformIO {
  if (!initData.mounts || initData.mounts.length === 0) {
    return new NodePlatformIO();
  }
  const backends = initData.mounts.map(m => ({
    mountPoint: m.mountPoint,
    backend: m.type === "host"
      ? new HostFileSystem(m.rootPath!)
      : m.initialize
        ? MemoryFileSystem.create(m.sharedBuffer!)
        : MemoryFileSystem.fromExisting(m.sharedBuffer!),
  }));
  return new VirtualPlatformIO(backends, new NodeTimeProvider());
}

if (parentPort) {
  const data = workerData as { type: string };
  if (data.type === "thread_init") {
    threadWorkerMain(parentPort, workerData as ThreadInitMessage, createIO).catch((e) => {
      console.error(`[worker-entry] threadWorkerMain error: ${e}`);
    });
  } else {
    workerMain(parentPort, workerData as WorkerInitMessage, createIO);
  }
}
