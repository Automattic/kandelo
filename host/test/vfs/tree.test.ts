import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { NodeTimeProvider } from "../../src/vfs/time";
import { readVfsTree, writeVfsTree, type VfsTreeEntry } from "../../src/vfs/tree";
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
    expect(hello?.kind === "file" && new TextDecoder().decode(hello.bytes!)).toBe("world\n");
    expect(hello?.mode).toBe(0o644);
    expect(hello?.uid).toBe(0);
    expect(hello?.kind === "file" && hello.mtimeMs).toBeGreaterThan(0);
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
      lstat: () => ({ mode: fifoMode, size: 0, uid: 1000, gid: 1000 }),
    } as unknown as PlatformIO;

    expect(await readVfsTree(io, "/run")).toEqual([
      { path: "fifo", kind: "other", mode: 0o620, uid: 1000, gid: 1000 },
    ]);
  });

  it("lists a regular file at a kernel FIFO path as other, and any other regular file as file", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "", 0o620);
    home.mkdir("/bar", 0o755);
    writeFile(home, "/bar/baz", "", 0o644);

    expect(await readVfsTree(io, "/home/maker", {}, new Set(["/home/maker/foo"]))).toEqual([
      { path: "bar", kind: "directory", mode: 0o755, uid: 0, gid: 0 },
      expect.objectContaining({ path: "bar/baz", kind: "file" }),
      { path: "foo", kind: "other", mode: 0o620, uid: 0, gid: 0 },
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
    expect(entry).toEqual({ path: "maker", kind: "directory", mode: 0o755, uid: 0, gid: 0 });
    expect((await readVfsTree(io, "/home")).map((e) => e.path)).toEqual([
      "maker",
      "maker/only-in-home",
    ]);
  });

  it("fails on a missing root instead of returning an empty tree", async () => {
    const { io } = homeIo();
    await expect(readVfsTree(io, "/home/nobody")).rejects.toThrow();
  });

  it("skips the bytes of a file whose fingerprint the caller holds, until it changes", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "foo");
    writeFile(home, "/bar", "bar");
    const first = await readVfsTree(io, "/home/maker");
    const known = Object.fromEntries(
      first.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.fingerprint]] : [])),
    );

    const unchanged = await readVfsTree(io, "/home/maker", known);
    expect(unchanged.map((entry) => entry.kind === "file" && entry.bytes)).toEqual([null, null]);

    writeFile(home, "/foo", "foo, longer");
    const changed = await readVfsTree(io, "/home/maker", known);
    const foo = changed.find((entry) => entry.path === "foo");
    expect(foo?.kind === "file" && new TextDecoder().decode(foo.bytes!)).toBe("foo, longer");
    expect(changed.find((entry) => entry.path === "bar")).toMatchObject({ bytes: null });
  });

  it("reads the bytes of a file named like an object property the caller does not hold", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/constructor", "foo");
    writeFile(home, "/__proto__", "bar");
    const entries = await readVfsTree(io, "/home/maker", {});
    expect(entries.map((entry) => entry.kind === "file" && new TextDecoder().decode(entry.bytes!)))
      .toEqual(["bar", "foo"]);
  });

  it("reads the bytes again after a change of mode alone", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "foo");
    const [first] = await readVfsTree(io, "/home/maker");
    const known = { foo: first!.kind === "file" ? first!.fingerprint : "" };
    await new Promise((resolve) => setTimeout(resolve, 5));
    home.chmod("/foo", 0o600);
    const [again] = await readVfsTree(io, "/home/maker", known);
    expect(again).toMatchObject({ mode: 0o600 });
    expect(again!.kind === "file" && again!.bytes).not.toBeNull();
  });
});

describe("writeVfsTree", () => {
  it("makes the tree hold exactly the entries, with their modes, owners, and times", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/.bashrc", "image default");
    home.mkdir("/stale", 0o755);
    writeFile(home, "/stale/qux", "qux");
    const bytes = new TextEncoder().encode("baz\n");
    const entries: VfsTreeEntry[] = [
      { path: ".bashrc", kind: "file", mode: 0o600, uid: 1000, gid: 1000, mtimeMs: 1_700_000_000_250, fingerprint: "", bytes },
      { path: "notes", kind: "directory", mode: 0o700, uid: 1000, gid: 1000 },
      { path: "notes/link", kind: "symlink", mode: 0o777, uid: 1000, gid: 1000, target: "../.bashrc" },
    ];

    await writeVfsTree(io, "/home/maker", entries);

    const tree = await readVfsTree(io, "/home/maker");
    expect(tree.map((entry) => [entry.path, entry.kind, entry.mode, entry.uid, entry.gid])).toEqual([
      [".bashrc", "file", 0o600, 1000, 1000],
      ["notes", "directory", 0o700, 1000, 1000],
      ["notes/link", "symlink", 0o777, 1000, 1000],
    ]);
    const bashrc = tree[0]!;
    expect(bashrc.kind === "file" && new TextDecoder().decode(bashrc.bytes!)).toBe("baz\n");
    expect(bashrc.kind === "file" && bashrc.mtimeMs).toBe(1_700_000_000_250);
    expect(tree[2]!.kind === "symlink" && tree[2]!.target).toBe("../.bashrc");
  });

  it("replaces a node of another kind and a symlink with a new target", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "foo");
    home.mkdir("/bar", 0o755);
    writeFile(home, "/bar/baz", "baz");
    home.symlink("foo", "/qux");
    const node = { mode: 0o755, uid: 0, gid: 0 };
    await writeVfsTree(io, "/home/maker", [
      { ...node, path: "bar", kind: "file", mtimeMs: 0, fingerprint: "", bytes: new TextEncoder().encode("bar") },
      { ...node, path: "foo", kind: "directory" },
      { ...node, mode: 0o777, path: "qux", kind: "symlink", target: "bar" },
    ]);
    const tree = await readVfsTree(io, "/home/maker");
    expect(tree.map((entry) => [entry.path, entry.kind])).toEqual([
      ["bar", "file"],
      ["foo", "directory"],
      ["qux", "symlink"],
    ]);
    expect(tree[2]!.kind === "symlink" && tree[2]!.target).toBe("bar");
  });

  it("keeps a wanted directory and removes its stale children", async () => {
    const { io, home } = homeIo();
    home.mkdir("/foo", 0o755);
    writeFile(home, "/foo/bar", "bar");
    home.mkdir("/foo/baz", 0o755);
    await writeVfsTree(io, "/home/maker", [{ path: "foo", kind: "directory", mode: 0o700, uid: 0, gid: 0 }]);
    expect(await readVfsTree(io, "/home/maker")).toEqual([
      { path: "foo", kind: "directory", mode: 0o700, uid: 0, gid: 0 },
    ]);
  });

  it("empties the root for an empty tree", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "foo");
    home.mkdir("/bar", 0o755);
    writeFile(home, "/bar/baz", "baz");
    await writeVfsTree(io, "/home/maker", []);
    expect(await readVfsTree(io, "/home/maker")).toEqual([]);
  });

  it("refuses a file without bytes, a node it cannot create, or a child before its directory", async () => {
    const { io, home } = homeIo();
    writeFile(home, "/foo", "foo");
    const node = { mode: 0o644, uid: 0, gid: 0 };
    const refused: VfsTreeEntry[][] = [
      [{ ...node, path: "bar", kind: "file", mtimeMs: 0, fingerprint: "", bytes: null }],
      [{ ...node, path: "fifo", kind: "other" }],
      [{ ...node, path: "dir/bar", kind: "symlink", target: "foo" }],
    ];
    for (const entries of refused) {
      await expect(writeVfsTree(io, "/home/maker", entries)).rejects.toThrow();
    }
    expect((await readVfsTree(io, "/home/maker")).map((entry) => entry.path)).toEqual(["foo"]);
  });
});
