import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { writeVfsBinary, writeVfsFile } from "../../src/vfs/image-helpers";
import {
  writeVfsBinary as writeBrowserVfsBinary,
  writeVfsFile as writeBrowserVfsFile,
} from "../../../apps/browser-demos/lib/init/vfs-utils";

const O_RDONLY = 0;

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const read = fs.read(fd, bytes, null, bytes.length);
    if (read !== bytes.length) {
      throw new Error(`short test read: ${read} of ${bytes.length}`);
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

describe("VFS image write helpers", () => {
  it("backs browser-demo writers with the shared strict helpers", () => {
    expect(writeBrowserVfsBinary).toBe(writeVfsBinary);
    expect(writeBrowserVfsFile).toBe(writeVfsFile);
  });

  it("stages every byte of a binary file", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const data = new Uint8Array(256 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    writeVfsBinary(fs, "/payload.bin", data, 0o640);

    expect(fs.stat("/payload.bin").size).toBe(data.length);
    expect(readFile(fs, "/payload.bin")).toEqual(data);
  });

  it("reports terminal ENOSPC after preserving a positive partial write", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(128 * 1024));
    const data = new Uint8Array(1024 * 1024).fill(0xa5);

    expect(() => writeVfsBinary(fs, "/partial.bin", data)).toThrow();
    expect(fs.stat("/partial.bin").size).toBeGreaterThan(0);
    expect(fs.stat("/partial.bin").size).toBeLessThan(data.length);
  });

  it("continues from the correct offset after a positive short write", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const close = vi.fn();
    const write = vi.fn()
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2);
    const fs = {
      open: vi.fn(() => 7),
      write,
      close,
    } as unknown as MemoryFileSystem;

    writeVfsBinary(fs, "/fixture.bin", data);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(write.mock.calls[0].slice(2)).toEqual([0, 4]);
    expect(write.mock.calls[1][1]).toEqual(new Uint8Array([3, 4]));
    expect(write.mock.calls[1].slice(2)).toEqual([2, 2]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(7);
  });

  it("closes the descriptor for zero, negative, invalid, and thrown writes", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const outcomes: Array<number | Error> = [
      0,
      -28,
      5,
      new Error("ENOSPC"),
    ];

    for (const outcome of outcomes) {
      const close = vi.fn();
      const fs = {
        open: vi.fn(() => 7),
        write: vi.fn(() => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }),
        close,
      } as unknown as MemoryFileSystem;

      expect(() => writeVfsBinary(fs, "/fixture.bin", data)).toThrow();
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(7);
    }
  });
});
