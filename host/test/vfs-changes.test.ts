import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY } from "../src/vfs/sharedfs-vendor";
import { NodeTimeProvider } from "../src/vfs/time";
import type { VfsChangeEvent } from "../src/vfs/types";
import { VirtualPlatformIO, vfsPathIsWithin } from "../src/vfs/vfs";

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/home", 0o755);
  mfs.mkdir("/home/maker", 0o755);
  return mfs;
}

function writeFile(mfs: MemoryFileSystem, path: string, text: string): void {
  const fd = mfs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  const bytes = new TextEncoder().encode(text);
  mfs.write(fd, bytes, null, bytes.length);
  mfs.close(fd);
}

function observe(mfs: MemoryFileSystem): { events: Array<Pick<VfsChangeEvent, "kind" | "path">>; off: () => void } {
  const events: Array<Pick<VfsChangeEvent, "kind" | "path">> = [];
  const off = mfs.subscribeChanges(({ kind, path }) => events.push({ kind, path }));
  return { events, off };
}

describe("MemoryFileSystem change events", () => {
  it("reports a modify once a handle opened for writing closes", () => {
    const mfs = createMemfs();
    const stamped: VfsChangeEvent[] = [];
    mfs.subscribeChanges((event) => stamped.push(event));

    const fd = mfs.open("/home/maker/foo.json", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    const bytes = new TextEncoder().encode("{}");
    mfs.write(fd, bytes, null, bytes.length);
    expect(stamped).toEqual([]);

    mfs.close(fd);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toMatchObject({ kind: "modify", path: "/home/maker/foo.json" });
    expect(stamped[0]!.t).toBeTypeOf("number");
  });

  it("does not report a read-only handle closing", () => {
    const mfs = createMemfs();
    writeFile(mfs, "/home/maker/foo.json", "{}");
    const { events } = observe(mfs);

    mfs.close(mfs.open("/home/maker/foo.json", O_RDONLY, 0));

    expect(events).toEqual([]);
  });

  it("reports unlink as a delete", () => {
    const mfs = createMemfs();
    writeFile(mfs, "/home/maker/foo.json", "{}");
    const { events } = observe(mfs);

    mfs.unlink("/home/maker/foo.json");

    expect(events).toEqual([{ kind: "delete", path: "/home/maker/foo.json" }]);
  });

  it("reports rename as a delete of the old name and a modify of the new one", () => {
    const mfs = createMemfs();
    writeFile(mfs, "/home/maker/foo.json", "{}");
    const { events } = observe(mfs);

    mfs.rename("/home/maker/foo.json", "/home/maker/bar.json");

    expect(events).toEqual([
      { kind: "delete", path: "/home/maker/foo.json" },
      { kind: "modify", path: "/home/maker/bar.json" },
    ]);
  });

  it("stops delivering after unsubscribe", () => {
    const mfs = createMemfs();
    const { events, off } = observe(mfs);
    writeFile(mfs, "/home/maker/foo.json", "{}");
    off();

    writeFile(mfs, "/home/maker/bar.json", "{}");

    expect(events).toEqual([{ kind: "modify", path: "/home/maker/foo.json" }]);
  });

  it("isolates a throwing listener from file I/O and other listeners", () => {
    const mfs = createMemfs();
    mfs.subscribeChanges(() => {
      throw new Error("listener failed");
    });
    const { events } = observe(mfs);

    expect(() => writeFile(mfs, "/home/maker/foo.json", "{}")).not.toThrow();

    expect(events).toEqual([{ kind: "modify", path: "/home/maker/foo.json" }]);
  });
});

describe("VirtualPlatformIO change events", () => {
  it("reports guest-namespace paths from every mount and stops on unsubscribe", () => {
    const root = createMemfs();
    const home = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }, { mountPoint: "/home/maker", backend: home }],
      new NodeTimeProvider(),
    );
    const events: Array<Pick<VfsChangeEvent, "kind" | "path">> = [];
    const off = io.subscribeChanges(({ kind, path }) => events.push({ kind, path }));

    const fd = io.open("/home/maker/foo.json", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    const bytes = new TextEncoder().encode("{}");
    io.write(fd, bytes, null, bytes.length);
    io.close(fd);
    io.unlink("/home/maker/foo.json");
    io.close(io.open("/bar.json", O_WRONLY | O_CREAT | O_TRUNC, 0o644));

    expect(events).toEqual([
      { kind: "modify", path: "/home/maker/foo.json" },
      { kind: "delete", path: "/home/maker/foo.json" },
      { kind: "modify", path: "/bar.json" },
    ]);

    off();
    io.unlink("/bar.json");
    expect(events).toHaveLength(3);
  });

  it("reports a backend exposed at several mount points under each name", () => {
    const root = createMemfs();
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }, { mountPoint: "/mirror", backend: root }],
      new NodeTimeProvider(),
    );
    const paths: string[] = [];
    io.subscribeChanges(({ path }) => paths.push(path));

    io.close(io.open("/home/maker/foo.json", O_WRONLY | O_CREAT | O_TRUNC, 0o644));

    expect(paths.sort()).toEqual(["/home/maker/foo.json", "/mirror/home/maker/foo.json"]);
  });
});

describe("vfsPathIsWithin", () => {
  it("matches the prefix itself and its descendants only", () => {
    expect(vfsPathIsWithin("/home/maker/mcp", "/home/maker/mcp")).toBe(true);
    expect(vfsPathIsWithin("/home/maker/mcp", "/home/maker/mcp/foo.json")).toBe(true);
    expect(vfsPathIsWithin("/home/maker/mcp/", "/home/maker/mcp/foo.json")).toBe(true);
    expect(vfsPathIsWithin("/home/maker/mcp", "/home/maker/mcp-old/foo.json")).toBe(false);
    expect(vfsPathIsWithin("/home/maker/mcp", "/home/maker")).toBe(false);
    expect(vfsPathIsWithin("/", "/foo")).toBe(true);
  });
});
