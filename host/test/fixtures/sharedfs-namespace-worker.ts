import { parentPort, workerData } from "node:worker_threads";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const { fsBuffer, controlBuffer, role, iterations } = workerData as {
  fsBuffer: SharedArrayBuffer;
  controlBuffer: SharedArrayBuffer;
  role: "mutator" | "observer";
  iterations: number;
};
const control = new Int32Array(controlBuffer);
const fs = MemoryFileSystem.fromExisting(fsBuffer);
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0x40;
const O_TRUNC = 0x200;

while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);

try {
  if (role === "mutator") {
    for (let i = 0; i < iterations; i++) {
      try { fs.unlink("/slot"); } catch { /* observer may hold an unlinked fd */ }

      let fd = fs.open("/other", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      fs.write(fd, new Uint8Array([0x22]), null, 1);
      fs.close(fd);
      fs.unlink("/other");

      fd = fs.open("/slot", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
      fs.write(fd, new Uint8Array([0x11]), null, 1);
      fs.close(fd);
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      let fd: number | null = null;
      try {
        fd = fs.open("/slot", O_RDONLY, 0);
        const byte = new Uint8Array(1);
        const read = fs.read(fd, byte, null, 1);
        if (read === 1 && byte[0] !== 0x11) {
          throw new Error(`path ABA exposed data from recycled inode: ${byte[0]}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("path ABA")) throw error;
        // ENOENT is valid between unlink and recreate.
      } finally {
        if (fd !== null) fs.close(fd);
      }
    }
  }
  parentPort!.postMessage({ ok: true });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
