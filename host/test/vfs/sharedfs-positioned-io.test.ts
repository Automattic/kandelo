import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import {
  O_APPEND,
  O_CREAT,
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
});
