import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import {
  DEFAULT_MOUNT_SPEC,
  ensureMountParentDirectories,
  resolveForBrowser,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import { resolveForNode } from "../../src/vfs/default-mounts-node";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
  type LazyAtomicSealForgery,
} from "../lazy-atomic-seal-fixture";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const PERMISSION_MASK = 0o777;
const FILE_TYPE_MASK = 0xf000;
const DIRECTORY_MODE = 0x4000;

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

async function buildForgedLegacyDinitImage(
  forgery: LazyAtomicSealForgery,
): Promise<Uint8Array> {
  const sab = new SharedArrayBuffer(2 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdir("/etc", 0o755);
  const group = new TextEncoder().encode("root:x:0:\nnogroup:x:65534:\n");
  const fd = mfs.open("/etc/group", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  mfs.write(fd, group, null, group.length);
  mfs.close(fd);
  await addSealedLazyAtomicTestTree(mfs, {
    groupId: `default-mounts:${forgery}`,
    member: forgery,
    root: `/sealed-${forgery}`,
  });
  return forgeLazyAtomicSeal(await mfs.saveImage(), forgery);
}

function readMountFile(backend: any, path: string): Uint8Array {
  const st = backend.stat(path);
  const fd = backend.open(path, O_RDONLY, 0);
  const buf = new Uint8Array(st.size);
  const n = backend.read(fd, buf, null, buf.length);
  backend.close(fd);
  return buf.subarray(0, n);
}

async function withUmask<T>(
  mask: number,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
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

  it("produces a MountConfig per spec entry", async () => {
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length);
    for (const m of mounts) {
      expect(typeof m.mountPoint).toBe("string");
      expect(m.backend).toBeDefined();
    }
  });

  it("/ mount is a MemoryFileSystem loaded from the supplied image", async () => {
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    const root = mounts.find((m) => m.mountPoint === "/");
    expect(root).toBeDefined();
    expect(root!.backend).toBeInstanceOf(MemoryFileSystem);
    expect(root!.readonly).toBe(true);

    const passwd = readMountFile(root!.backend, "/etc/passwd");
    expect(new TextDecoder().decode(passwd)).toContain("root:x:0:0");
  });

  it("/tmp mount is a HostFileSystem rooted under sessionDir", async () => {
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
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

  it("pre-creates every scratch directory under sessionDir", async () => {
    await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    for (const spec of DEFAULT_MOUNT_SPEC) {
      if (spec.source !== "scratch") continue;
      const expected = join(sessionDir, spec.path);
      expect(existsSync(expected), `expected ${expected} to exist`).toBe(true);
      expect(statSync(expected).isDirectory()).toBe(true);
    }
  });

  it("applies declared scratch directory modes natively on creation and virtually", async () => {
    const modeSessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-default-mount-modes-"));
    const mounts = await withUmask(0, () =>
      resolveForNode(DEFAULT_MOUNT_SPEC, image, modeSessionDir)
    );
    const tmp = mounts.find((m) => m.mountPoint === "/tmp")!;
    const varTmp = mounts.find((m) => m.mountPoint === "/var/tmp")!;
    const home = mounts.find((m) => m.mountPoint === "/home/user")!;
    const root = mounts.find((m) => m.mountPoint === "/root")!;

    try {
      expect(tmp.backend.stat("/").mode & 0o7777).toBe(0o1777);
      expect(varTmp.backend.stat("/").mode & 0o7777).toBe(0o1777);
      expect(home.backend.stat("/").uid).toBe(1000);
      expect(home.backend.stat("/").gid).toBe(1000);
      expect(root.backend.stat("/").mode & 0o7777).toBe(0o700);
      expect(root.backend.stat("/").uid).toBe(0);
      expect(root.backend.stat("/").gid).toBe(0);
      expect(statSync(join(modeSessionDir, "tmp")).mode & PERMISSION_MASK).toBe(0o777);
      expect(statSync(join(modeSessionDir, "var", "tmp")).mode & PERMISSION_MASK).toBe(0o777);
      expect(statSync(join(modeSessionDir, "root")).mode & 0o7777).toBe(0o700);
    } finally {
      rmSync(modeSessionDir, { recursive: true, force: true });
    }
  });

  it("adds the nobody group to legacy dinit images", async () => {
    const legacyImage = await buildLegacyDinitImage();
    const mounts = await resolveForNode(
      DEFAULT_MOUNT_SPEC,
      legacyImage,
      sessionDir,
    );
    const root = mounts.find((m) => m.mountPoint === "/")!;
    const group = new TextDecoder().decode(readMountFile(root.backend, "/etc/group"));
    expect(group).toContain("nogroup:x:65534:");
    expect(group).toContain("nobody:x:65534:");
  });

  it.each(["member", "cohort"] as const)(
    "rejects a forged %s seal before Node scratch directories are created",
    async (forgery) => {
      const forgedImage = await buildForgedLegacyDinitImage(forgery);
      const isolatedSessionDir = mkdtempSync(
        join(tmpdir(), "wasm-posix-forged-default-mounts-"),
      );
      const scratchFirst: MountSpec[] = [
        { path: "/tmp", source: "scratch" },
        { path: "/", source: "image" },
      ];
      try {
        await expect(
          resolveForNode(scratchFirst, forgedImage, isolatedSessionDir),
        ).rejects.toThrow(/activation (member|group)/);
        // Arbitrary specs may put scratch first. Two-phase resolution must
        // still authenticate every image before touching the host filesystem.
        expect(existsSync(join(isolatedSessionDir, "tmp"))).toBe(false);
      } finally {
        rmSync(isolatedSessionDir, { recursive: true, force: true });
      }
    },
  );

  it("creates missing rootfs ancestors for nested runtime mount points", async () => {
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    const root = mounts.find((m) => m.mountPoint === "/")!.backend as MemoryFileSystem;

    expect(() => root.stat("/usr/local")).toThrow();
    ensureMountParentDirectories(root, ["/usr/local/lib/kandelo"]);

    for (const path of ["/usr", "/usr/local", "/usr/local/lib"]) {
      expect(root.stat(path).mode & FILE_TYPE_MASK).toBe(DIRECTORY_MODE);
    }
    expect(() => root.stat("/usr/local/lib/kandelo")).toThrow();
  });

  it("does not hide non-directory rootfs ancestors", async () => {
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    const root = mounts.find((m) => m.mountPoint === "/")!.backend as MemoryFileSystem;
    const fd = root.open("/usr", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    root.close(fd);

    ensureMountParentDirectories(root, ["/usr/local/lib/kandelo"]);

    expect(root.stat("/usr").mode & FILE_TYPE_MASK).not.toBe(DIRECTORY_MODE);
    expect(() => root.stat("/usr/local")).toThrow();
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

  it("produces image-backed and memfs-scratch backends only", async () => {
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    expect(mounts).toHaveLength(DEFAULT_MOUNT_SPEC.length);

    for (const m of mounts) {
      expect(m.backend).toBeInstanceOf(MemoryFileSystem);
      expect(m.backend).not.toBeInstanceOf(HostFileSystem);
    }
  });

  it("/ mount is image-backed and reads /etc/passwd from the image", async () => {
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    const root = mounts.find((m) => m.mountPoint === "/");
    expect(root).toBeDefined();
    const passwd = readMountFile(root!.backend, "/etc/passwd");
    expect(new TextDecoder().decode(passwd)).toContain("root:x:0:0");
  });

  it("scratch mounts are independent writable memfs instances", async () => {
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
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

  it("applies declared scratch root modes", async () => {
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    const tmp = mounts.find((m) => m.mountPoint === "/tmp")!.backend as MemoryFileSystem;
    const varTmp = mounts.find((m) => m.mountPoint === "/var/tmp")!.backend as MemoryFileSystem;
    const home = mounts.find((m) => m.mountPoint === "/home/user")!.backend as MemoryFileSystem;
    const root = mounts.find((m) => m.mountPoint === "/root")!.backend as MemoryFileSystem;
    expect(tmp.stat("/").mode & 0o7777).toBe(0o1777);
    expect(varTmp.stat("/").mode & 0o7777).toBe(0o1777);
    expect(home.stat("/").uid).toBe(1000);
    expect(home.stat("/").gid).toBe(1000);
    expect(root.stat("/").mode & 0o7777).toBe(0o700);
    expect(root.stat("/").uid).toBe(0);
    expect(root.stat("/").gid).toBe(0);
  });

  it("adds the nobody group to legacy dinit images", async () => {
    const legacyImage = await buildLegacyDinitImage();
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, legacyImage, {
      scratchSabBytes: tinyScratch,
    });
    const root = mounts.find((m) => m.mountPoint === "/")!;
    const group = new TextDecoder().decode(readMountFile(root.backend, "/etc/group"));
    expect(group).toContain("nogroup:x:65534:");
    expect(group).toContain("nobody:x:65534:");
  });

  it.each(["member", "cohort"] as const)(
    "rejects a forged %s seal before browser scratch filesystems are allocated",
    async (forgery) => {
      const forgedImage = await buildForgedLegacyDinitImage(forgery);
      const createSpy = vi.spyOn(MemoryFileSystem, "create");
      const scratchFirst: MountSpec[] = [
        { path: "/tmp", source: "scratch" },
        { path: "/", source: "image" },
      ];
      try {
        await expect(
          resolveForBrowser(scratchFirst, forgedImage, {
            scratchSabBytes: tinyScratch,
          }),
        ).rejects.toThrow(/activation (member|group)/);
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
      }
    },
  );

  it("scratchSabBytes overrides apply per mount", async () => {
    const explicit = {
      "/tmp": 4 * 1024 * 1024,
      "/var/log": 256 * 1024,
    };
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
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
