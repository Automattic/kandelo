import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { installPosixShell } from "../src/vfs/image-helpers";

const O_RDONLY = 0x0000;

function createMemfs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const out = new Uint8Array(st.size);
    const n = fs.read(fd, out, null, out.length);
    return out.subarray(0, n);
  } finally {
    fs.close(fd);
  }
}

describe("VFS image helpers", () => {
  it("installs dash as the POSIX sh provider", () => {
    const fs = createMemfs();
    const dashBytes = new Uint8Array([0, 97, 115, 109, 1, 2, 3, 4]);

    installPosixShell(fs, dashBytes);

    expect(readFile(fs, "/bin/dash")).toEqual(dashBytes);
    expect(fs.stat("/bin/dash").mode & 0o777).toBe(0o755);
    expect(fs.readlink("/bin/sh")).toBe("/bin/dash");
    expect(fs.readlink("/usr/bin/dash")).toBe("/bin/dash");
    expect(fs.readlink("/usr/bin/sh")).toBe("/bin/dash");
  });
});
