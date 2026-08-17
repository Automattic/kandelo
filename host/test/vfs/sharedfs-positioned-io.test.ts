import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import {
  MAX_FDS,
  O_APPEND,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  SEEK_SET,
  SharedFS,
} from "../../src/vfs/sharedfs-vendor";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

describe("SharedFS positioned I/O", () => {
  it("append is explicit and independent of flags captured at open", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = SharedFS.mkfs(sab);
    const fd = fs.open("/append.tmp", O_RDWR | O_CREAT | O_TRUNC, 0o600);

    expect(fs.write(fd, encoder.encode("abc"))).toBe(3);
    expect(fs.lseek(fd, 1, SEEK_SET)).toBe(1);
    expect(fs.append(fd, encoder.encode("!"), null)).toEqual({
      written: 1,
      end: 4,
    });
    expect(fs.writeAt(fd, encoder.encode("X"), 1)).toBe(1);

    expect(fs.lseek(fd, 0, SEEK_SET)).toBe(0);
    const full = new Uint8Array(4);
    expect(fs.read(fd, full)).toBe(4);
    expect(text(full)).toBe("aXc!");
  });

  it("readAt and writeAt do not mutate the shared fd offset", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = SharedFS.mkfs(sab);
    const fd = fs.open(
      "/sorter.tmp",
      O_RDWR | O_CREAT | O_TRUNC | O_APPEND,
      0o600,
    );

    expect(fs.write(fd, encoder.encode("0123456789abcdef"))).toBe(16);
    expect(fs.lseek(fd, 10, SEEK_SET)).toBe(10);

    const positionedRead = new Uint8Array(4);
    expect(fs.readAt(fd, positionedRead, 2)).toBe(4);
    expect(text(positionedRead)).toBe("2345");

    expect(fs.writeAt(fd, encoder.encode("XY"), 4)).toBe(2);

    const sequentialRead = new Uint8Array(3);
    expect(fs.read(fd, sequentialRead)).toBe(3);
    expect(text(sequentialRead)).toBe("abc");

    expect(fs.lseek(fd, 0, SEEK_SET)).toBe(0);
    const full = new Uint8Array(16);
    expect(fs.read(fd, full)).toBe(16);
    expect(text(full)).toBe("0123XY6789abcdef");
  });

  it("MemoryFileSystem pread and pwrite keep the shared offset stable", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open(
      "/sorter.tmp",
      O_RDWR | O_CREAT | O_TRUNC | O_APPEND,
      0o600,
    );

    expect(fs.write(fd, encoder.encode("0123456789abcdef"), null, 16)).toBe(16);
    expect(fs.seek(fd, 10, SEEK_SET)).toBe(10);

    const positionedRead = new Uint8Array(4);
    expect(fs.read(fd, positionedRead, 2, 4)).toBe(4);
    expect(text(positionedRead)).toBe("2345");

    expect(fs.write(fd, encoder.encode("XY"), 4, 2)).toBe(2);

    const sequentialRead = new Uint8Array(3);
    expect(fs.read(fd, sequentialRead, null, 3)).toBe(3);
    expect(text(sequentialRead)).toBe("abc");

    expect(fs.seek(fd, 0, SEEK_SET)).toBe(0);
    const full = new Uint8Array(16);
    expect(fs.read(fd, full, null, 16)).toBe(16);
    expect(text(full)).toBe("0123XY6789abcdef");
  });

  it("MemoryFileSystem exposes one explicit append operation", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/append.tmp", O_RDWR | O_CREAT | O_TRUNC, 0o600);

    expect(fs.write(fd, encoder.encode("abc"), null, 3)).toBe(3);
    expect(fs.seek(fd, 0, SEEK_SET)).toBe(0);
    expect(fs.append(fd, encoder.encode("!"), 1, null)).toEqual({
      written: 1,
      end: 4,
    });
    expect(fs.write(fd, encoder.encode("X"), 1, 1)).toBe(1);

    const full = new Uint8Array(4);
    expect(fs.read(fd, full, 0, full.length)).toBe(4);
    expect(text(full)).toBe("aXc!");
  });

  it("clears set-ID after a genuinely short positive scalar write", () => {
    const fs = SharedFS.mkfs(new SharedArrayBuffer(1024 * 1024));
    const path = "/short-scalar";
    const fd = fs.open(path, O_RDWR | O_CREAT | O_TRUNC, 0o600);
    fs.chmod(path, 0o6755);
    const requested = new Uint8Array(2 * 1024 * 1024);

    const written = fs.write(fd, requested);

    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(requested.byteLength);
    expect(fs.stat(path).mode & 0o7777).toBe(0o755);
    expect(fs.fstat(fd).mode & 0o7777).toBe(0o755);
    fs.close(fd);
  });

  it("clears set-ID after a genuinely short positive positioned write", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const path = "/short-positioned";
    const fd = fs.open(path, O_RDWR | O_CREAT | O_TRUNC, 0o600);
    fs.chmod(path, 0o6755);
    const requested = new Uint8Array(2 * 1024 * 1024);

    const written = fs.write(fd, requested, 0, requested.byteLength);

    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(requested.byteLength);
    expect(fs.stat(path).mode & 0o7777).toBe(0o755);
    expect(fs.fstat(fd).mode & 0o7777).toBe(0o755);
    fs.close(fd);
  });

  it("applies the append limit under the inode lock and reports exact EOF", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const first = MemoryFileSystem.create(sab);
    const second = MemoryFileSystem.fromExisting(sab);
    const firstFd = first.open(
      "/limited.tmp",
      O_RDWR | O_CREAT | O_TRUNC,
      0o600,
    );
    const secondFd = second.open("/limited.tmp", O_RDWR, 0o600);

    expect(first.write(firstFd, encoder.encode("abc"), null, 3)).toBe(3);
    expect(
      first.append(firstFd, encoder.encode("wxyz"), 4, 5),
    ).toEqual({ written: 2, end: 5 });
    expect(
      second.append(secondFd, encoder.encode("!"), 1, 5),
    ).toEqual({ written: 0, end: 5 });
    expect(
      second.append(secondFd, encoder.encode("!"), 1, null),
    ).toEqual({ written: 1, end: 6 });

    const full = new Uint8Array(6);
    expect(first.read(firstFd, full, 0, full.length)).toBe(6);
    expect(text(full)).toBe("abcwx!");
  });

  it("serializes two interleaved append actors through the exact limit", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open(
      "/append-race",
      O_RDWR | O_CREAT | O_TRUNC,
      0o600,
    );
    fs.close(fd);

    const markerLength = 5;
    const iterations = 200;
    const limit = markerLength * iterations * 2;
    const controlBuffer = new SharedArrayBuffer(4);
    const control = new Int32Array(controlBuffer);
    const workerUrl = new URL(
      "../fixtures/sharedfs-append-worker.ts",
      import.meta.url,
    );
    const workers = ["AAAA\n", "BBBB\n"].map(
      (marker) =>
        new Worker(workerUrl, {
          execArgv: ["--import", "tsx"],
          workerData: {
            fsBuffer: sab,
            controlBuffer,
            marker,
            iterations,
            limit,
          },
        }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`append worker exited ${code}`));
          });
        }),
    );

    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, workers.length);
    try {
      expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }

    const verifyFd = fs.open("/append-race", O_RDWR, 0);
    expect(fs.fstat(verifyFd).size).toBe(limit);
    expect(
      fs.append(verifyFd, encoder.encode("X"), 1, limit),
    ).toEqual({ written: 0, end: limit });
    const bytes = new Uint8Array(limit);
    expect(fs.read(verifyFd, bytes, 0, bytes.length)).toBe(bytes.length);
    for (let offset = 0; offset < bytes.length; offset += markerLength) {
      expect(["AAAA\n", "BBBB\n"]).toContain(
        text(bytes.subarray(offset, offset + markerLength)),
      );
    }
    fs.close(verifyFd);
  }, 10_000);

  it("publishes distinct lowest descriptors across concurrent workers", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const seed = fs.open(
      "/reservation-race",
      O_RDWR | O_CREAT | O_TRUNC,
      0o600,
    );
    fs.close(seed);
    const fillers: number[] = [];
    for (let index = 0; index < MAX_FDS - 2; index++) {
      fillers.push(fs.open("/reservation-race", O_RDONLY, 0));
    }

    const controlBuffer = new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(controlBuffer);
    const workerUrl = new URL(
      "../fixtures/sharedfs-fd-reservation-worker.ts",
      import.meta.url,
    );
    const workers = [0, 1].map(
      (slot) =>
        new Worker(workerUrl, {
          execArgv: ["--import", "tsx"],
          workerData: { fsBuffer: sab, controlBuffer, slot },
        }),
    );
    const results = workers.map(
      (worker) =>
        new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`fd worker exited ${code}`));
          });
        }),
    );

    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, workers.length);
    try {
      const deadline = Date.now() + 5_000;
      while (Atomics.load(control, 1) !== workers.length) {
        if (Date.now() >= deadline) {
          throw new Error("fd reservation workers did not publish in time");
        }
        await Atomics.waitAsync(
          control,
          1,
          Atomics.load(control, 1),
          100,
        ).value;
      }
      expect(new Set([Atomics.load(control, 3), Atomics.load(control, 4)]))
        .toEqual(new Set([MAX_FDS - 2, MAX_FDS - 1]));

      Atomics.store(control, 2, 1);
      Atomics.notify(control, 2, workers.length);
      expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }]);

      const reused = fs.open("/reservation-race", O_RDONLY, 0);
      expect(reused).toBe(MAX_FDS - 2);
      fs.close(reused);
    } finally {
      Atomics.store(control, 2, 1);
      Atomics.notify(control, 2, workers.length);
      await Promise.all(workers.map((worker) => worker.terminate()));
      for (const filler of fillers) fs.close(filler);
    }
  }, 10_000);
});
