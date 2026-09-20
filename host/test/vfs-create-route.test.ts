import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { ST_NOSUID } from "../src/vfs/types";
// The flag numbers from the generated ABI rather than from the vendored
// filesystem: `sharedfs-vendor.ts` goes with `memory-fs.ts`, and these are
// POSIX constants the ABI already publishes.
import { OPEN_FLAGS } from "../src/generated/abi";

const { O_CREAT, O_RDWR } = OPEN_FLAGS;

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

/**
 * A backend for `VirtualPlatformIO` to ROUTE to, which is this file's whole
 * subject: it spies on `statfs` to see which mount the router consulted, and
 * never cares which filesystem answered.
 *
 * `HostFileSystem` rather than `MemoryFileSystem` — and this file already used
 * one, three cases below, over the same `roots` scaffolding. Both implement
 * `FileSystemBackend`; this is the one the platform still ships and Node still
 * mounts for scratch, rather than the filesystem lane V deletes. Nothing here
 * ever needed a `SharedArrayBuffer`. It needed an object with mounts.
 */
function backendFileSystem(): HostFileSystem {
  const root = mkdtempSync(join(tmpdir(), "kandelo-create-route-"));
  roots.push(root);
  return new HostFileSystem(root);
}

describe("VirtualPlatformIO create-route metadata", () => {
  it("creates a missing final path from its existing parent route", () => {
    const backend = backendFileSystem();
    const statfs = vi.spyOn(backend, "statfs");
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const fd = io.open("/created", O_CREAT | O_RDWR, 0o6755);
    try {
      expect(statfs).toHaveBeenCalledWith("/");
      expect(io.stat("/created").mode & 0o7777).toBe(0o6755);
      expect(io.fstatfs(fd).flags & ST_NOSUID).toBe(0);
    } finally {
      io.close(fd);
    }
  });

  it("uses the selected nested mount's parent without consulting root", () => {
    const root = backendFileSystem();
    const nested = backendFileSystem();
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
    const backend = backendFileSystem();
    const statfs = vi.spyOn(backend, "statfs");
    const io = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    // ENOENT, however the backend spells it. `MemoryFileSystem` said "No such
    // file"; a host-backed mount reports node's own "ENOENT: no such file or
    // directory, stat …". The claim is that the target's absence is what
    // propagates when `O_CREAT` is missing — not that a particular filesystem
    // phrased it a particular way.
    expect(() => io.open("/missing", O_RDWR, 0)).toThrow(/ENOENT|No such file/i);
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
