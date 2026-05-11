import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import {
  DEFAULT_MOUNT_SPEC,
  resolveForBrowser,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import { resolveForNode } from "../../src/vfs/default-mounts-node";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

async function buildFixtureImage(): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(2 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/etc", 0o755);
  const passwd = new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n");
  const fd = mfs.open("/etc/passwd", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, passwd, null, passwd.length);
  mfs.close(fd);
  return await mfs.saveImage();
}

async function buildLegacyDinitImage(): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(2 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/etc", 0o755);
  const group = new TextEncoder().encode("root:x:0:\nnogroup:x:65534:\n");
  const fd = mfs.open("/etc/group", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, group, null, group.length);
  mfs.close(fd);
  return await mfs.saveImage();
}

function readMountFile(backend: any, path: string): Uint8Array {
  const st = backend.stat(path);
  const fd = backend.open(path, O_RDONLY, 0);
  const buf = new Uint8Array(st.size);
  const n = backend.read(fd, buf, null, buf.length);
  backend.close(fd);
  return buf.subarray(0, n);
}

describe("DEFAULT_MOUNT_SPEC", () => {
  it("includes the eight canonical mount points", () => {
    const paths = DEFAULT_MOUNT_SPEC.map((m) => m.path).sort();
    expect(paths).toEqual(
      [
        "/",
        "/home/user",
        "/root",
        "/srv",
        "/tmp",
        "/var/log",
        "/var/run",
        "/var/tmp",
      ].sort(),
    );
    expect(DEFAULT_MOUNT_SPEC).toHaveLength(8);
  });

  it("declares / as a read-only image mount", () => {
    const root = DEFAULT_MOUNT_SPEC.find((m) => m.path === "/");
    expect(root).toBeDefined();
    expect(root!.source).toBe("image");
    expect(root!.readonly).toBe(true);
  });
});

describe("resolveForNode", () => {
  let image: Uint8Array;
  let sessionDir: string;

  beforeAll(async () => {
    image = await buildFixtureImage();
    sessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-default-mounts-"));
  });

  afterAll(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("produces a MountConfig per spec entry", () => {
    const mounts = resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length);
    for (const m of mounts) {
      expect(typeof m.mountPoint).toBe("string");
      expect(m.backend).toBeDefined();
    }
  });

  it("/ mount is a MemoryFileSystem loaded from the supplied image", () => {
    const mounts = resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    const root = mounts.find((m) => m.mountPoint === "/");
    expect(root).toBeDefined();
    expect(root!.backend).toBeInstanceOf(MemoryFileSystem);
    expect(root!.readonly).toBe(true);

    const passwd = readMountFile(root!.backend, "/etc/passwd");
    expect(new TextDecoder().decode(passwd)).toContain("root:x:0:0");
  });

  it("/tmp mount is a HostFileSystem rooted under sessionDir", () => {
    const mounts = resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    const tmp = mounts.find((m) => m.mountPoint === "/tmp");
    expect(tmp).toBeDefined();
    expect(tmp!.backend).toBeInstanceOf(HostFileSystem);

    const data = new TextEncoder().encode("hello via host fs");
    const fd = tmp!.backend.open("/note.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    tmp!.backend.write(fd, data, null, data.length);
    tmp!.backend.close(fd);

    const onDisk = readFileSync(join(sessionDir, "tmp", "note.txt"));
    expect(new TextDecoder().decode(onDisk)).toBe("hello via host fs");
  });

  it("pre-creates every scratch directory under sessionDir", () => {
    resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    for (const spec of DEFAULT_MOUNT_SPEC) {
      if (spec.source !== "scratch") continue;
      const expected = join(sessionDir, spec.path);
      expect(existsSync(expected), `expected ${expected} to exist`).toBe(true);
      expect(statSync(expected).isDirectory()).toBe(true);
    }
  });

  it("applies declared scratch directory modes", () => {
    resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    expect(statSync(join(sessionDir, "tmp")).mode & 0o7777).toBe(0o1777);
    expect(statSync(join(sessionDir, "var", "tmp")).mode & 0o7777).toBe(0o1777);
    expect(statSync(join(sessionDir, "root")).mode & 0o7777).toBe(0o700);
  });

  it("adds the nobody group to legacy dinit images", async () => {
    const legacyImage = await buildLegacyDinitImage();
    const mounts = resolveForNode(DEFAULT_MOUNT_SPEC, legacyImage, sessionDir);
    const root = mounts.find((m) => m.mountPoint === "/")!;
    const group = new TextDecoder().decode(readMountFile(root.backend, "/etc/group"));
    expect(group).toContain("nogroup:x:65534:");
    expect(group).toContain("nobody:x:65534:");
  });

  it("throws on duplicate mount paths", () => {
    const dup: MountSpec[] = [
      { path: "/", source: "image" },
      { path: "/tmp", source: "scratch" },
      { path: "/tmp", source: "scratch" },
    ];
    expect(() => resolveForNode(dup, image, sessionDir)).toThrow(/duplicate/i);
  });

  it("throws on a non-absolute mount path", () => {
    const bad: MountSpec[] = [{ path: "tmp", source: "scratch" }];
    expect(() => resolveForNode(bad, image, sessionDir)).toThrow(/absolute/i);
  });

  it("rejects mount paths with . or .. segments", () => {
    const dotSpec: MountSpec[] = [{ path: "/foo/./bar", source: "scratch" }];
    expect(() => resolveForNode(dotSpec, image, sessionDir)).toThrow();

    const dotDotSpec: MountSpec[] = [{ path: "/foo/../bar", source: "scratch" }];
    expect(() => resolveForNode(dotDotSpec, image, sessionDir)).toThrow();
  });

  it("rejects trailing slash on non-root mount paths", () => {
    const bad: MountSpec[] = [{ path: "/tmp/", source: "scratch" }];
    expect(() => resolveForNode(bad, image, sessionDir)).toThrow();
  });
});

describe("resolveForBrowser", () => {
  let image: Uint8Array;
  // Shrink scratch SABs so the 7 scratch mounts × default 16 MiB don't
  // OOM the test runner (`mkfs` zero-fills every SAB up front). The
  // production default lives in `BROWSER_SCRATCH_SAB_BYTES`.
  const tinyScratch = Object.fromEntries(
    DEFAULT_MOUNT_SPEC.filter((m) => m.source === "scratch").map((m) => [
      m.path,
      256 * 1024,
    ]),
  );

  beforeAll(async () => {
    image = await buildFixtureImage();
  });

  it("produces image-backed and memfs-scratch backends only", () => {
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length);

    for (const m of mounts) {
      expect(m.backend).toBeInstanceOf(MemoryFileSystem);
      expect(m.backend).not.toBeInstanceOf(HostFileSystem);
    }
  });

  it("/ mount is image-backed and reads /etc/passwd from the image", () => {
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    const root = mounts.find((m) => m.mountPoint === "/");
    expect(root).toBeDefined();
    const passwd = readMountFile(root!.backend, "/etc/passwd");
    expect(new TextDecoder().decode(passwd)).toContain("root:x:0:0");
  });

  it("scratch mounts are independent writable memfs instances", () => {
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    const tmp = mounts.find((m) => m.mountPoint === "/tmp");
    const home = mounts.find((m) => m.mountPoint === "/home/user");
    expect(tmp).toBeDefined();
    expect(home).toBeDefined();
    expect(tmp!.backend).not.toBe(home!.backend);

    const data = new TextEncoder().encode("scratch");
    const fd = tmp!.backend.open("/x.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    tmp!.backend.write(fd, data, null, data.length);
    tmp!.backend.close(fd);
    expect(new TextDecoder().decode(readMountFile(tmp!.backend, "/x.txt"))).toBe(
      "scratch",
    );
    expect(() => home!.backend.stat("/x.txt")).toThrow();
  });

  it("applies declared scratch root modes", () => {
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    const tmp = mounts.find((m) => m.mountPoint === "/tmp")!.backend as MemoryFileSystem;
    const varTmp = mounts.find((m) => m.mountPoint === "/var/tmp")!.backend as MemoryFileSystem;
    const root = mounts.find((m) => m.mountPoint === "/root")!.backend as MemoryFileSystem;
    expect(tmp.stat("/").mode & 0o7777).toBe(0o1777);
    expect(varTmp.stat("/").mode & 0o7777).toBe(0o1777);
    expect(root.stat("/").mode & 0o7777).toBe(0o700);
  });

  it("adds the nobody group to legacy dinit images", async () => {
    const legacyImage = await buildLegacyDinitImage();
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, legacyImage, {
      scratchSabBytes: tinyScratch,
    });
    const root = mounts.find((m) => m.mountPoint === "/")!;
    const group = new TextDecoder().decode(readMountFile(root.backend, "/etc/group"));
    expect(group).toContain("nogroup:x:65534:");
    expect(group).toContain("nobody:x:65534:");
  });

  it("scratchSabBytes overrides apply per mount", () => {
    const explicit = {
      "/tmp": 4 * 1024 * 1024,
      "/var/log": 256 * 1024,
    };
    const mounts = resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: { ...tinyScratch, ...explicit },
    });
    const tmp = mounts.find((m) => m.mountPoint === "/tmp")!.backend as MemoryFileSystem;
    const log = mounts.find((m) => m.mountPoint === "/var/log")!.backend as MemoryFileSystem;
    expect(tmp.sharedBuffer.byteLength).toBe(4 * 1024 * 1024);
    expect(log.sharedBuffer.byteLength).toBe(256 * 1024);
  });

  it("throws on duplicate mount paths", () => {
    const dup: MountSpec[] = [
      { path: "/", source: "image" },
      { path: "/tmp", source: "scratch" },
      { path: "/tmp", source: "scratch" },
    ];
    expect(() => resolveForBrowser(dup, image)).toThrow(/duplicate/i);
  });
});
