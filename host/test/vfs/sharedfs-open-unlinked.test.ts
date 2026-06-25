import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createMemfs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
}

function writeText(fs: MemoryFileSystem, fd: number, text: string): void {
  const bytes = encoder.encode(text);
  expect(fs.write(fd, bytes, null, bytes.length)).toBe(bytes.length);
}

function readText(fs: MemoryFileSystem, fd: number, length: number): string {
  const out = new Uint8Array(length);
  const nread = fs.read(fd, out, null, out.length);
  return decoder.decode(out.subarray(0, nread));
}

function readPath(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    return readText(fs, fd, st.size);
  } finally {
    fs.close(fd);
  }
}

describe("SharedFS open-unlinked file lifetime", () => {
  it("keeps an unlinked file readable and writable through its open fd", () => {
    const fs = createMemfs();
    const fd = fs.open("/sqlite-temp", O_RDWR | O_CREAT | O_TRUNC, 0o600);
    writeText(fs, fd, "before unlink");

    fs.unlink("/sqlite-temp");
    expect(() => fs.stat("/sqlite-temp")).toThrow();

    fs.seek(fd, 0, 0);
    expect(readText(fs, fd, "before unlink".length)).toBe("before unlink");

    writeText(fs, fd, " plus more");
    fs.seek(fd, 0, 0);
    expect(readText(fs, fd, "before unlink plus more".length))
      .toBe("before unlink plus more");

    const replacement = fs.open("/replacement", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    writeText(fs, replacement, "replacement");
    fs.close(replacement);

    fs.seek(fd, 0, 0);
    expect(readText(fs, fd, "before unlink plus more".length))
      .toBe("before unlink plus more");
    expect(readPath(fs, "/replacement")).toBe("replacement");

    fs.close(fd);
    expect(() => fs.stat("/sqlite-temp")).toThrow();
  });

  it("preserves an open file replaced by rename until its fd closes", () => {
    const fs = createMemfs();
    const oldFd = fs.open("/target", O_RDWR | O_CREAT | O_TRUNC, 0o644);
    writeText(fs, oldFd, "old target");

    const newFd = fs.open("/source", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    writeText(fs, newFd, "new target");
    fs.close(newFd);

    fs.rename("/source", "/target");
    expect(readPath(fs, "/target")).toBe("new target");

    fs.seek(oldFd, 0, 0);
    expect(readText(fs, oldFd, "old target".length)).toBe("old target");

    fs.close(oldFd);
    expect(readPath(fs, "/target")).toBe("new target");
    expect(() => fs.stat("/source")).toThrow();
  });
});
