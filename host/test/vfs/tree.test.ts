import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { NodeTimeProvider } from "../../src/vfs/time";
import { readVfsTree } from "../../src/vfs/tree";
import { FILE_MODES, OPEN_FLAGS } from "../../src/generated/abi";
import type { PlatformIO } from "../../src/types";

const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;

function writeFile(fs: MemoryFileSystem, path: string, text: string, mode = 0o644): void {
  const bytes = new TextEncoder().encode(text);
  const fd = fs.open(path, O_WRONLY_CREAT_TRUNC, mode);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

function homeIo(): { io: VirtualPlatformIO; home: MemoryFileSystem } {
  const root = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  root.mkdir("/home", 0o755);
  root.mkdir("/home/maker", 0o755);
  const home = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  const io = new VirtualPlatformIO(
    [
      { mountPoint: "/", backend: root },
      { mountPoint: "/home/maker", backend: home },
    ],
    new NodeTimeProvider(),
  );
  return { io, home };
}

describe("readVfsTree", () => {
  it("lists directories, files, symlinks, and other nodes in name order, depth first", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/hello.txt", "world\n");
    home.mkdir("/notes", 0o700);
    writeFile(home, "/notes/foo.md", "foo", 0o600);
    home.symlink("hello.txt", "/notes/link");
    home.mkdir("/empty", 0o755);
    writeFile(home, "/.bash_history", "ls\n");

    const entries = await readVfsTree(io, "/home/maker");

    expect(entries.map((entry) => [entry.path, entry.kind])).toEqual([
      [".bash_history", "file"],
      ["empty", "directory"],
      ["hello.txt", "file"],
      ["notes", "directory"],
      ["notes/foo.md", "file"],
      ["notes/link", "symlink"],
    ]);
    const hello = entries.find((entry) => entry.path === "hello.txt");
    expect(hello?.kind === "file" && new TextDecoder().decode(hello.bytes)).toBe("world\n");
    expect(hello?.mode).toBe(0o644);
    const notes = entries.find((entry) => entry.path === "notes");
    expect(notes?.mode).toBe(0o700);
    const link = entries.find((entry) => entry.path === "notes/link");
    expect(link?.kind === "symlink" && link.target).toBe("hello.txt");
  });

  it("lists a node it cannot carry as other, with its mode", async () => {
    const fifoMode = FILE_MODES.S_IFIFO | 0o620;
    let readdirCalls = 0;
    const io = {
      opendir: () => 7,
      readdir: () => (readdirCalls++ === 0 ? { name: "fifo", type: 0, ino: 1 } : null),
      closedir: () => undefined,
      lstat: () => ({ mode: fifoMode, size: 0 }),
    } as unknown as PlatformIO;

    expect(await readVfsTree(io, "/run")).toEqual([
      { path: "fifo", kind: "other", mode: 0o620 },
    ]);
  });

  it("reads an empty directory as no entries", async () => {
    const { io } = homeIo();
    expect(await readVfsTree(io, "/home/maker")).toEqual([]);
  });

  it("crosses into the mount that owns the root", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/only-in-home", "x");
    const [entry] = await readVfsTree(io, "/home");
    expect(entry).toEqual({ path: "maker", kind: "directory", mode: 0o755 });
    expect((await readVfsTree(io, "/home")).map((e) => e.path)).toEqual([
      "maker",
      "maker/only-in-home",
    ]);
  });

  it("fails on a missing root instead of returning an empty tree", async () => {
    const { io } = homeIo();
    await expect(readVfsTree(io, "/home/nobody")).rejects.toThrow();
  });
});
