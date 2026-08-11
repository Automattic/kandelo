import { parentPort, workerData } from "node:worker_threads";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { O_RDONLY } from "../../src/vfs/sharedfs-vendor";

const { fsBuffer, controlBuffer, slot } = workerData as {
  fsBuffer: SharedArrayBuffer;
  controlBuffer: SharedArrayBuffer;
  slot: number;
};
const control = new Int32Array(controlBuffer);
const fs = MemoryFileSystem.fromExisting(fsBuffer);

while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);

let fd: number | null = null;
try {
  fd = fs.open("/reservation-race", O_RDONLY, 0);
  Atomics.store(control, 3 + slot, fd);
  Atomics.add(control, 1, 1);
  Atomics.notify(control, 1, 1);
  while (Atomics.load(control, 2) === 0) Atomics.wait(control, 2, 0);
  fs.close(fd);
  fd = null;
  parentPort!.postMessage({ ok: true });
} catch (error) {
  if (fd !== null) {
    try {
      fs.close(fd);
    } catch {
      // Preserve the reservation/open failure.
    }
  }
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
