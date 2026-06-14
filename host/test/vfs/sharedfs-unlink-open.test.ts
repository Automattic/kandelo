import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function writeAll(fs: MemoryFileSystem, fd: number, data: Uint8Array): void {
  const n = fs.write(fd, data, null, data.length);
  expect(n).toBe(data.length);
}

function readAll(fs: MemoryFileSystem, fd: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const n = fs.read(fd, out, null, out.length);
  expect(n).toBe(len);
  return out;
}

describe("SharedFS open-unlink semantics", () => {
  it("keeps an unlinked regular file alive until its open fd closes", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const first = fs.open("/tmp-a", O_RDWR | O_CREAT | O_TRUNC, 0o600);
    const firstData = new Uint8Array(96 * 1024);
    firstData.fill(0x61);
    writeAll(fs, first, firstData);

    fs.unlink("/tmp-a");
    expect(() => fs.stat("/tmp-a")).toThrow();

    const second = fs.open("/tmp-b", O_WRONLY | O_CREAT | O_TRUNC, 0o600);
    const secondData = new Uint8Array(16 * 1024);
    secondData.fill(0x62);
    writeAll(fs, second, secondData);

    expect(fs.fstat(first).size).toBe(firstData.length);
    fs.seek(first, 0, 0);
    expect(readAll(fs, first, firstData.length)).toEqual(firstData);

    fs.close(second);
    fs.close(first);

    const verify = fs.open("/tmp-b", O_RDONLY, 0);
    expect(fs.fstat(verify).size).toBe(secondData.length);
    expect(readAll(fs, verify, secondData.length)).toEqual(secondData);
    fs.close(verify);
  });
});
