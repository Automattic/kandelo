import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { ST_NOSUID } from "../src/vfs/types";
import { O_CREAT, O_RDWR } from "../src/vfs/sharedfs-vendor";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function memoryFileSystem(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
}

describe("VirtualPlatformIO create-route metadata", () => {
  it("creates a missing final path from its existing parent route", () => {
    const backend = memoryFileSystem();
    const statfs = vi.spyOn(backend, "statfs");
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const fd = io.open("/created", O_CREAT | O_RDWR, 0o6755);
    try {
      expect(statfs).toHaveBeenCalledWith("/");
      expect(io.stat("/created").mode & 0o7777).toBe(0o6755);
      expect(io.fstatfs(fd).flags & ST_NOSUID).toBe(ST_NOSUID);
    } finally {
      io.close(fd);
    }
  });

  it("uses the selected nested mount's parent without consulting root", () => {
    const root = memoryFileSystem();
    const nested = memoryFileSystem();
    const rootStatfs = vi.spyOn(root, "statfs");
    const nestedStatfs = vi.spyOn(nested, "statfs");
    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: nested },
      ],
      new NodeTimeProvider(),
    );

    const fd = io.open("/tmp/created", O_CREAT | O_RDWR, 0o600);
    io.close(fd);

    expect(nestedStatfs).toHaveBeenCalledWith("/");
    expect(rootStatfs).not.toHaveBeenCalled();
    expect(nested.stat("/created").mode & 0o7777).toBe(0o600);
    expect(() => root.stat("/tmp/created")).toThrow();
  });

  it("retains target ENOENT when O_CREAT is absent", () => {
    const backend = memoryFileSystem();
    const statfs = vi.spyOn(backend, "statfs");
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    expect(() => io.open("/missing", O_RDWR, 0)).toThrow(/No such file/);
    expect(statfs).toHaveBeenCalledWith("/missing");
    expect(() => backend.stat("/missing")).toThrow();
  });

  it("does not let parent lookup authorize traversal outside a host mount", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-create-route-"));
    roots.push(root);
    const outside = `${root}-escape`;
    const escapeName = outside.slice(outside.lastIndexOf("/") + 1);
    rmSync(outside, { force: true });
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: new HostFileSystem(root) }],
      new NodeTimeProvider(),
    );

    expect(() => io.open(`/../${escapeName}`, O_CREAT | O_RDWR, 0o600))
      .toThrow(/EACCES/);
    expect(existsSync(outside)).toBe(false);
  });
});
