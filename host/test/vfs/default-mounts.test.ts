import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import {
  DEFAULT_MOUNT_SPEC,
  ensureMountParentDirectories,
  resolveForBrowser,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import {
  resolveForNode,
  resolveForNodeKernelSession,
} from "../../src/vfs/default-mounts-node";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
  type LazyAtomicSealForgery,
} from "../lazy-atomic-seal-fixture";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const O_APPEND = 0x0400;
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

function typeScriptSources(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...typeScriptSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
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

describe("Node worker session seed trees", () => {
  it("keeps exact native append branding limited to the private-session resolver", () => {
    const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
    const token = "createSessionOwnedHostFileSystem";
    const uses = typeScriptSources(sourceRoot)
      .map((path) => ({
        count: readFileSync(path, "utf8").split(token).length - 1,
        file: relative(sourceRoot, path).replaceAll("\\", "/"),
      }))
      .filter(({ count }) => count > 0)
      .sort((left, right) => left.file.localeCompare(right.file));

    expect(uses).toEqual([
      { count: 2, file: "vfs/default-mounts-node.ts" },
      { count: 1, file: "vfs/host-fs.ts" },
    ]);
  });

  it("authenticates the root image before inspecting or staging seeds", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-auth-"));
    const forgedImage = await buildForgedLegacyDinitImage("member");
    try {
      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          forgedImage,
          sessionRoot,
          [{
            sourcePath: join(sessionRoot, "does-not-exist"),
            destinationPath: "/tmp/kandelo-run",
          }],
        ),
      ).rejects.toThrow(/activation member/i);
      expect(existsSync(join(sessionRoot, "tmp"))).toBe(false);
      expect(existsSync(join(sessionRoot, ".seed-staging-0"))).toBe(false);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("breaks external hardlink aliases before granting exact append authority", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-snapshot-source-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-snapshot-session-"));
    const outside = join(fixtureRoot, "outside");
    const source = join(fixtureRoot, "fixtures");
    const staged = join(source, "suite", "fixture");
    try {
      mkdirSync(join(source, "suite"), { recursive: true });
      writeFileSync(outside, "seed");
      linkSync(outside, staged);

      const mounts = await resolveForNodeKernelSession(
        DEFAULT_MOUNT_SPEC,
        await buildFixtureImage(),
        sessionRoot,
        [{
          sourcePath: source,
          destinationPath: "/tmp/kandelo-run",
        }],
      );
      const mount = mounts.find((entry) => entry.mountPoint === "/tmp")!;

      // The source entry still aliases the external file. Mutating it after
      // initialization must not replace bytes inside the worker-owned copy.
      writeFileSync(outside, "external");
      expect(readFileSync(staged, "utf8")).toBe("external");
      expect(new TextDecoder().decode(
        readMountFile(mount.backend, "/kandelo-run/suite/fixture"),
      )).toBe("seed");

      const bytes = new TextEncoder().encode("+guest");
      const fd = mount.backend.open(
        "/kandelo-run/suite/fixture",
        O_WRONLY | O_APPEND,
        0,
      );
      try {
        expect(mount.backend.append(fd, bytes, bytes.byteLength, null)).toEqual({
          written: bytes.byteLength,
          end: 10,
        });
      } finally {
        mount.backend.close(fd);
      }

      expect(new TextDecoder().decode(
        readMountFile(mount.backend, "/kandelo-run/suite/fixture"),
      )).toBe("seed+guest");
      expect(readFileSync(outside, "utf8")).toBe("external");
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects image destinations and a source that contains the private session", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-snapshot-validation-"));
    const source = join(fixtureRoot, "source");
    const nestedSession = join(source, "worker-session");
    mkdirSync(nestedSession, { recursive: true });
    try {
      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          await buildFixtureImage(),
          nestedSession,
          [{ sourcePath: source, destinationPath: "/etc/fixtures" }],
        )
      ).rejects.toThrow(/below a scratch mount/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          await buildFixtureImage(),
          nestedSession,
          [{
            sourcePath: source,
            destinationPath: "/tmp/kandelo-run",
          }],
        )
      ).rejects.toThrow(/contains the private session/i);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects source symlinks before publishing a seeded backend", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-symlink-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-session-"));
    const source = join(fixtureRoot, "source");
    mkdirSync(source);
    writeFileSync(join(fixtureRoot, "outside"), "outside");
    symlinkSync("../outside", join(source, "escape"));
    try {
      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          await buildFixtureImage(),
          sessionRoot,
          [{
            sourcePath: source,
            destinationPath: "/tmp/kandelo-run",
          }],
        ),
      ).rejects.toThrow(/symlink or unsupported special entry/i);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("publishes no final destination when a later seed copy fails", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-atomic-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-session-"));
    const valid = join(fixtureRoot, "valid");
    const invalid = join(fixtureRoot, "invalid");
    mkdirSync(valid);
    mkdirSync(invalid);
    writeFileSync(join(valid, "complete"), "complete");
    writeFileSync(join(fixtureRoot, "outside"), "outside");
    symlinkSync("../outside", join(invalid, "escape"));
    try {
      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          await buildFixtureImage(),
          sessionRoot,
          [
            { sourcePath: valid, destinationPath: "/tmp/first" },
            { sourcePath: invalid, destinationPath: "/tmp/second" },
          ],
        ),
      ).rejects.toThrow(/symlink or unsupported special entry/i);
      expect(existsSync(join(sessionRoot, "tmp", "first"))).toBe(false);
      expect(existsSync(join(sessionRoot, "tmp", "second"))).toBe(false);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("publishes a seed through the deepest declared scratch mount", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-routing-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-session-"));
    const source = join(fixtureRoot, "source");
    mkdirSync(source);
    writeFileSync(join(source, "value"), "seed");
    const nestedScratchSpec: MountSpec[] = [
      { path: "/", source: "image", readonly: true },
      { path: "/tmp", source: "scratch" },
      { path: "/tmp/nested", source: "scratch" },
    ];
    try {
      const mounts = await resolveForNodeKernelSession(
        nestedScratchSpec,
        await buildFixtureImage(),
        sessionRoot,
        [{
          sourcePath: source,
          destinationPath: "/tmp/nested/fixtures",
        }],
      );
      const owner = mounts.find(
        (mount) => mount.mountPoint === "/tmp/nested",
      )!;
      expect(new TextDecoder().decode(
        readMountFile(owner.backend, "/fixtures/value"),
      )).toBe("seed");
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects overlapping, mount-shadowed, and mount-root destinations", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-overlap-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "kandelo-seed-session-"));
    const first = join(fixtureRoot, "first");
    const second = join(fixtureRoot, "second");
    mkdirSync(first);
    mkdirSync(second);
    const image = await buildFixtureImage();
    try {
      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [
            { sourcePath: first, destinationPath: "/tmp/fixtures" },
            { sourcePath: second, destinationPath: "/tmp/fixtures/nested" },
          ],
        ),
      ).rejects.toThrow(/destinations overlap/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/tmp/extra/fixtures" }],
          ["/tmp/extra"],
        ),
      ).rejects.toThrow(/overlaps another mount/i);

      const nestedImageSpec: MountSpec[] = [
        { path: "/", source: "image", readonly: true },
        { path: "/tmp", source: "scratch" },
        { path: "/tmp/shadow", source: "image", readonly: true },
      ];
      await expect(
        resolveForNodeKernelSession(
          nestedImageSpec,
          image,
          sessionRoot,
          [{
            sourcePath: first,
            destinationPath: "/tmp/shadow/fixtures",
          }],
        ),
      ).rejects.toThrow(/routed through a scratch mount/i);

      const nestedScratchSpec: MountSpec[] = [
        { path: "/", source: "image", readonly: true },
        { path: "/tmp", source: "scratch" },
        { path: "/tmp/fixtures/nested", source: "scratch" },
      ];
      await expect(
        resolveForNodeKernelSession(
          nestedScratchSpec,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/tmp/fixtures" }],
        ),
      ).rejects.toThrow(/overlaps another declared mount/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/tmp" }],
        ),
      ).rejects.toThrow(/below a scratch mount/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [
            { sourcePath: first, destinationPath: "/tmp/fixtures" },
            { sourcePath: second, destinationPath: "/tmp//fixtures" },
          ],
        ),
      ).rejects.toThrow(/canonical POSIX path/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/tmp/extra/fixtures" }],
          ["/tmp//extra"],
        ),
      ).rejects.toThrow(/canonical POSIX path/i);

      await expect(
        resolveForNodeKernelSession(
          DEFAULT_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: "relative", destinationPath: "/tmp/relative" }],
        ),
      ).rejects.toThrow(/source path must be absolute/i);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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

  it("restores the exact caller mount spec without adding default overlays", async () => {
    const productSpec: MountSpec[] = [
      { path: "/", source: "image", readonly: false },
      {
        path: "/tmp",
        source: "scratch",
        mode: 0o1777,
        uid: 0,
        gid: 0,
        ephemeral: true,
      },
    ];
    const mounts = await restoreBrowserKernelInitMounts(image, productSpec);
    expect(mounts.map((mount) => mount.mountPoint)).toEqual(["/", "/tmp"]);
    expect(mounts[0]!.readonly).toBe(false);
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
