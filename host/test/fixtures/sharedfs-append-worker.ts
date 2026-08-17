import { parentPort, workerData } from "node:worker_threads";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const {
  fsBuffer,
  controlBuffer,
  marker,
  iterations,
  limit,
} = workerData as {
  fsBuffer: SharedArrayBuffer;
  controlBuffer: SharedArrayBuffer;
  marker: string;
  iterations: number;
  limit: number;
};

const O_RDWR = 0x0002;
const control = new Int32Array(controlBuffer);
const fs = MemoryFileSystem.fromExisting(fsBuffer);
const fd = fs.open("/append-race", O_RDWR, 0);
const record = new TextEncoder().encode(marker);

while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);

try {
  for (let index = 0; index < iterations; index++) {
    const outcome = fs.append(fd, record, record.byteLength, limit);
    if (
      outcome.written !== record.byteLength
      || outcome.end < outcome.written
      || outcome.end % record.byteLength !== 0
    ) {
      throw new Error(
        `invalid append outcome ${JSON.stringify(outcome)} for ${marker}`,
      );
    }
  }
  fs.close(fd);
  parentPort!.postMessage({ ok: true });
} catch (error) {
  try {
    fs.close(fd);
  } catch {
    // Preserve the append failure.
  }
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
