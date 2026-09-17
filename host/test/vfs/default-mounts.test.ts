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
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { HostFileSystem } from "../../src/vfs/host-fs";
import {
  DEFAULT_MOUNT_SPEC,
  filterMountSpecForKernelTmpfs,
  KERNEL_TMPFS_OWNED_PREFIXES,
  resolveForBrowser,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import {
  resolveForNode,
  resolveForNodeKernelSession,
} from "../../src/vfs/default-mounts-node";
import { restoreBrowserKernelInitMounts } from "../../src/browser-kernel-vfs-init";
import { ST_NOSUID } from "../../src/vfs/types";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import { NodeTimeProvider } from "../../src/vfs/time";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const O_APPEND = 0x0400;
const PERMISSION_MASK = 0o777;
const FILE_TYPE_MASK = 0xf000;
const DIRECTORY_MODE = 0x4000;

async function buildFixtureImage(): Promise<Uint8Array> {
  // Built by the producer that writes every shipped image: these cases are
  // about what the MOUNT RESOLVERS do with a `/` image, and an image from a
  // writer no product uses can differ in exactly the way they would not
  // notice.
  const mfs = KandeloImageFs.create();
  mfs.mkdir("/etc", 0o755);
  mfs.writeFile(
    "/etc/passwd",
    new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
    0o644,
  );
  return await mfs.saveImage();
}

async function buildLegacyDinitImage(): Promise<Uint8Array> {
  const mfs = KandeloImageFs.create();
  mfs.mkdir("/etc", 0o755);
  mfs.writeFile(
    "/etc/group",
    new TextEncoder().encode("root:x:0:\nnogroup:x:65534:\n"),
    0o644,
  );
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
        "/home/maker",
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

  it("declares / as a writable set-ID-capable image mount", () => {
    const root = DEFAULT_MOUNT_SPEC.find((m) => m.path === "/");
    expect(root).toBeDefined();
    expect(root!.source).toBe("image");
    expect(root!.readonly).toBe(false);
    expect(root!.nosuid).not.toBe(true);
  });

  it("declares every auto-created scratch mount nosuid", () => {
    const scratch = DEFAULT_MOUNT_SPEC.filter((mount) =>
      mount.source === "scratch"
    );

    expect(scratch.length).toBeGreaterThan(0);
    expect(scratch.every((mount) => mount.nosuid === true)).toBe(true);
  });
});

// Post-cutover the in-kernel tmpfs is the unconditional authority for its
// scratch prefixes, so `resolveForNode`/`resolveForBrowser` always drop the
// tmpfs-owned scratch mounts (`/tmp`, `/var/tmp`, `/var/log`, `/var/run`,
// `/home/maker`, `/root`, `/srv`). The resolver still materialises host/memfs
// scratch backends for any *non*-tmpfs scratch mount, so these suites exercise
// that surviving machinery through a spec of non-tmpfs scratch paths that mirror
// the canonical mode/uid/gid variety.
const HOST_SCRATCH_MOUNT_SPEC: MountSpec[] = [
  { path: "/", source: "image", readonly: false },
  { path: "/run", source: "scratch", mode: 0o1777, ephemeral: true, nosuid: true },
  { path: "/var/spool", source: "scratch", mode: 0o1777, nosuid: true },
  { path: "/var/cache", source: "scratch", mode: 0o755, nosuid: true },
  { path: "/opt/run", source: "scratch", mode: 0o755, ephemeral: true, nosuid: true },
  {
    path: "/home/dev",
    source: "scratch",
    mode: 0o755,
    uid: 1000,
    gid: 1000,
    nosuid: true,
  },
  { path: "/opt/admin", source: "scratch", mode: 0o700, uid: 0, gid: 0, nosuid: true },
  { path: "/opt/srv", source: "scratch", mode: 0o755, nosuid: true },
];

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

  it("produces a MountConfig per HOST-BACKED spec entry, and none for the image", async () => {
    const mounts = await resolveForNode(HOST_SCRATCH_MOUNT_SPEC, image, sessionDir);
    // An image mount gets no backend and therefore no mount: the kernel serves
    // `/` itself, and the filesystem the resolver used to build for it was
    // dropped from the guest mounts unread.
    const hostBacked = HOST_SCRATCH_MOUNT_SPEC.filter((m) => m.source !== "image");
    expect(mounts.map((m) => m.mountPoint).sort())
      .toEqual(hostBacked.map((m) => m.path).sort());
    const io = new VirtualPlatformIO(mounts, new NodeTimeProvider());
    for (const m of mounts) {
      expect(typeof m.mountPoint).toBe("string");
      expect(m.backend).toBeDefined();
      expect(io.statfs(m.mountPoint).flags & ST_NOSUID).toBe(ST_NOSUID);
    }
  });

  it("emits no `/` mount at all, because the kernel is its authority", async () => {
    // INVERTED, deliberately. This asserted that `/` came back as a
    // `MemoryFileSystem` loaded from the image — up to a gigabyte materialized
    // once per boot, then filtered out of the guest-facing `VirtualPlatformIO`
    // because the kernel has been the sole `/` authority since the Phase 5
    // cutover. Pinning its ABSENCE is what stops the restore coming back.
    const mounts = await resolveForNode(DEFAULT_MOUNT_SPEC, image, sessionDir);
    expect(mounts.find((m) => m.mountPoint === "/")).toBeUndefined();
  });

  it("a host-scratch mount is a HostFileSystem rooted under sessionDir", async () => {
    const mounts = await resolveForNode(HOST_SCRATCH_MOUNT_SPEC, image, sessionDir);
    const run = mounts.find((m) => m.mountPoint === "/run");
    expect(run).toBeDefined();
    expect(run!.backend).toBeInstanceOf(HostFileSystem);

    const data = new TextEncoder().encode("hello via host fs");
    const fd = run!.backend.open("/note.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    run!.backend.write(fd, data, null, data.length);
    run!.backend.close(fd);

    const onDisk = readFileSync(join(sessionDir, "run", "note.txt"));
    expect(new TextDecoder().decode(onDisk)).toBe("hello via host fs");
  });

  it("keeps a uid/gid-owned profile on a writable Node scratch mount", async () => {
    const profileSessionDir = mkdtempSync(
      join(tmpdir(), "wasm-posix-scratch-profile-"),
    );
    const mounts = await resolveForNode(
      HOST_SCRATCH_MOUNT_SPEC,
      image,
      profileSessionDir,
    );
    const home = mounts.find((m) => m.mountPoint === "/home/dev");

    try {
      expect(home).toBeDefined();
      const data = new TextEncoder().encode("dev node profile");
      const fd = home!.backend.open(
        "/profile.txt",
        O_WRONLY | O_CREAT | O_TRUNC,
        0o644,
      );
      home!.backend.write(fd, data, null, data.length);
      home!.backend.close(fd);
      expect(
        readFileSync(
          join(profileSessionDir, "home", "dev", "profile.txt"),
          "utf8",
        ),
      ).toBe("dev node profile");
    } finally {
      rmSync(profileSessionDir, { recursive: true, force: true });
    }
  });

  it("pre-creates every scratch directory under sessionDir", async () => {
    await resolveForNode(HOST_SCRATCH_MOUNT_SPEC, image, sessionDir);
    for (const spec of HOST_SCRATCH_MOUNT_SPEC) {
      if (spec.source !== "scratch") continue;
      const expected = join(sessionDir, spec.path);
      expect(existsSync(expected), `expected ${expected} to exist`).toBe(true);
      expect(statSync(expected).isDirectory()).toBe(true);
    }
  });

  it("applies declared scratch directory modes natively on creation and virtually", async () => {
    const modeSessionDir = mkdtempSync(join(tmpdir(), "wasm-posix-default-mount-modes-"));
    const mounts = await withUmask(0, () =>
      resolveForNode(HOST_SCRATCH_MOUNT_SPEC, image, modeSessionDir)
    );
    const sticky = mounts.find((m) => m.mountPoint === "/run")!;
    const varSpool = mounts.find((m) => m.mountPoint === "/var/spool")!;
    const home = mounts.find((m) => m.mountPoint === "/home/dev")!;
    const admin = mounts.find((m) => m.mountPoint === "/opt/admin")!;

    try {
      expect(sticky.backend.stat("/").mode & 0o7777).toBe(0o1777);
      expect(varSpool.backend.stat("/").mode & 0o7777).toBe(0o1777);
      expect(home.backend.stat("/").uid).toBe(1000);
      expect(home.backend.stat("/").gid).toBe(1000);
      expect(admin.backend.stat("/").mode & 0o7777).toBe(0o700);
      expect(admin.backend.stat("/").uid).toBe(0);
      expect(admin.backend.stat("/").gid).toBe(0);
      expect(statSync(join(modeSessionDir, "run")).mode & PERMISSION_MASK).toBe(0o777);
      expect(statSync(join(modeSessionDir, "var", "spool")).mode & PERMISSION_MASK).toBe(0o777);
      expect(statSync(join(modeSessionDir, "opt", "admin")).mode & 0o7777).toBe(0o700);
    } finally {
      rmSync(modeSessionDir, { recursive: true, force: true });
    }
  });

  // The image is restored verbatim: the host does not amend `/etc/group`.
  // `normalizeLegacyRootfs` used to append a `nobody` line here for
  // already-published demo images, and it was deleted with the boot cutover —
  // every image builder emits the line, and the kernel now builds its tree from
  // the image bytes, so a host-side amendment would silently do nothing.
  // RETIRED 2026-09-16, both copies: "restores a legacy dinit image's
  // /etc/group verbatim".
  //
  // They read `/etc/group` back out of the `/` mount's backend to prove the
  // resolver handed the image's content through unmodified. There is no `/`
  // mount to read it from: an image mount gets no host backend, because the
  // kernel serves `/`.
  //
  // The claim was never the resolver's to make anyway — it is that an image's
  // bytes survive being read, which belongs to whoever reads them.
  // `runtime-core`'s `a_load_leaves_the_image_it_was_handed_byte_for_byte_unchanged`
  // asserts it of the loader that now does, and `rootfs-etc-overlay.test.ts`
  // asserts the `/etc` content path end to end through the image module.




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
        HOST_SCRATCH_MOUNT_SPEC,
        await buildFixtureImage(),
        sessionRoot,
        [{
          sourcePath: source,
          destinationPath: "/run/kandelo-run",
        }],
      );
      const mount = mounts.find((entry) => entry.mountPoint === "/run")!;

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
          HOST_SCRATCH_MOUNT_SPEC,
          await buildFixtureImage(),
          nestedSession,
          [{ sourcePath: source, destinationPath: "/etc/fixtures" }],
        )
      ).rejects.toThrow(/below a scratch mount/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          await buildFixtureImage(),
          nestedSession,
          [{
            sourcePath: source,
            destinationPath: "/run/kandelo-run",
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
          HOST_SCRATCH_MOUNT_SPEC,
          await buildFixtureImage(),
          sessionRoot,
          [{
            sourcePath: source,
            destinationPath: "/run/kandelo-run",
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
          HOST_SCRATCH_MOUNT_SPEC,
          await buildFixtureImage(),
          sessionRoot,
          [
            { sourcePath: valid, destinationPath: "/run/first" },
            { sourcePath: invalid, destinationPath: "/run/second" },
          ],
        ),
      ).rejects.toThrow(/symlink or unsupported special entry/i);
      expect(existsSync(join(sessionRoot, "run", "first"))).toBe(false);
      expect(existsSync(join(sessionRoot, "run", "second"))).toBe(false);
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
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [
            { sourcePath: first, destinationPath: "/run/fixtures" },
            { sourcePath: second, destinationPath: "/run/fixtures/nested" },
          ],
        ),
      ).rejects.toThrow(/destinations overlap/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/run/extra/fixtures" }],
          ["/run/extra"],
        ),
      ).rejects.toThrow(/overlaps another mount/i);

      const nestedImageSpec: MountSpec[] = [
        { path: "/", source: "image", readonly: true },
        { path: "/run", source: "scratch" },
        { path: "/run/shadow", source: "image", readonly: true },
      ];
      await expect(
        resolveForNodeKernelSession(
          nestedImageSpec,
          image,
          sessionRoot,
          [{
            sourcePath: first,
            destinationPath: "/run/shadow/fixtures",
          }],
        ),
      ).rejects.toThrow(/routed through a scratch mount/i);

      const nestedScratchSpec: MountSpec[] = [
        { path: "/", source: "image", readonly: true },
        { path: "/run", source: "scratch" },
        { path: "/run/fixtures/nested", source: "scratch" },
      ];
      await expect(
        resolveForNodeKernelSession(
          nestedScratchSpec,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/run/fixtures" }],
        ),
      ).rejects.toThrow(/overlaps another declared mount/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/run" }],
        ),
      ).rejects.toThrow(/below a scratch mount/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [
            { sourcePath: first, destinationPath: "/run/fixtures" },
            { sourcePath: second, destinationPath: "/run//fixtures" },
          ],
        ),
      ).rejects.toThrow(/canonical POSIX path/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: first, destinationPath: "/run/extra/fixtures" }],
          ["/run//extra"],
        ),
      ).rejects.toThrow(/canonical POSIX path/i);

      await expect(
        resolveForNodeKernelSession(
          HOST_SCRATCH_MOUNT_SPEC,
          image,
          sessionRoot,
          [{ sourcePath: "relative", destinationPath: "/run/relative" }],
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
  // Shrink scratch SABs so the scratch mounts × default 16 MiB don't OOM the
  // test runner (`mkfs` zero-fills every SAB up front). The production default
  // lives in `BROWSER_SCRATCH_SAB_BYTES`.
  const tinyScratch = Object.fromEntries(
    HOST_SCRATCH_MOUNT_SPEC.filter((m) => m.source === "scratch").map((m) => [
      m.path,
      256 * 1024,
    ]),
  );

  beforeAll(async () => {
    image = await buildFixtureImage();
  });

  // RETIRED 2026-09-16 with the browser's memfs-backed scratch mount, five
  // cases: "produces memfs-scratch backends only", "restores the caller's
  // host-backed mounts without adding default overlays", "keeps a uid/gid
  // profile on an independent writable browser scratch mount", "applies
  // declared scratch root modes", and "scratchSabBytes overrides apply per
  // mount".
  //
  // All five drove `resolveForBrowser` into building a `MemoryFileSystem` over
  // a `SharedArrayBuffer` for a scratch path, which is the last production use
  // of the class this lane deletes. The browser resolver refuses such a mount
  // now rather than backing it: the eight prefixes the in-kernel tmpfs owns are
  // filtered out before it looks, and the browser host has no filesystem of its
  // own to mount anywhere else.
  //
  // THE ASYMMETRY WITH NODE IS DELIBERATE and is not a parity gap. Node backs a
  // non-tmpfs scratch mount with a `HostFileSystem` over a real session
  // directory, because session seed trees must land below a surviving scratch
  // mount — `materializeSessionSeedTrees` insists on it, and the kernel's own
  // `rootfs.rs` names `/run/kandelo-run` as the canonical foreign mount. The
  // browser protocol carries no `sessionSeedTrees` field, so the facility that
  // justifies Node's branch cannot reach the browser's.
  //
  // What replaces them is one case asserting the refusal, below.

  it("refuses a browser scratch mount the kernel does not serve", async () => {
    await expect(
      resolveForBrowser(
        [
          { path: "/", source: "image" },
          { path: "/run", source: "scratch", mode: 0o755 },
        ],
        image,
      ),
    ).rejects.toThrow(/browser scratch mount \/run has no backend/);
  });

  it("resolves the canonical spec to no mounts at all", async () => {
    // Every scratch path in `DEFAULT_MOUNT_SPEC` is one the in-kernel tmpfs
    // owns, and `/` is the kernel's too, so the browser host mounts nothing.
    // Pinning the empty result is what makes the removal visible: a future
    // change that reintroduced a host backend would show up here rather than
    // as a second authority the kernel never consults.
    expect(await resolveForBrowser(DEFAULT_MOUNT_SPEC, image)).toEqual([]);
  });



  it("emits no `/` mount in the browser either", async () => {
    const mounts = await resolveForBrowser(DEFAULT_MOUNT_SPEC, image, {
      scratchSabBytes: tinyScratch,
    });
    expect(mounts.find((m) => m.mountPoint === "/")).toBeUndefined();
  });



  // See the Node case above: the host restores `/etc/group` verbatim.

  // RETIRED 2026-09-16 with the resolvers' authentication, three cases:
  //   - "rejects a forged %s seal before Node scratch directories are created"
  //   - "authenticates the root image before inspecting or staging seeds"
  //   - "rejects a forged %s seal before browser scratch filesystems are allocated"
  //
  // Each asserted an ORDERING: the image is authenticated before the host
  // touches anything. The resolvers no longer authenticate — they no longer
  // restore the image at all, because the `/` mount they were building it for
  // is dropped from the guest mounts and the kernel serves `/` itself.
  //
  // The property under the ordering survives, moved rather than dropped: a
  // refused image must not leave a half-built machine behind. Node asserts it
  // in `node-kernel-init-refused-image.test.ts` (init fails, with a negative
  // control that the same tree boots when nothing is declared wrong), the
  // browser in `vfs-import-seal-boundary.spec.ts` (no kernel worker survives),
  // and the Node entry still releases its per-boot session directory in
  // `buildVirtualPlatformIO`'s catch. What is genuinely gone is "before",
  // and the plan records why that ordering was not a trust boundary.

  it("throws on duplicate mount paths", () => {
    const dup: MountSpec[] = [
      { path: "/", source: "image" },
      { path: "/tmp", source: "scratch" },
      { path: "/tmp", source: "scratch" },
    ];
    expect(() => resolveForBrowser(dup, image)).toThrow(/duplicate/i);
  });
});

describe("filterMountSpecForKernelTmpfs (Phase 5 cutover)", () => {
  const spec: MountSpec[] = [
    { path: "/", source: "image" },
    ...KERNEL_TMPFS_OWNED_PREFIXES.map((path) => ({
      path,
      source: "scratch" as const,
    })),
    { path: "/run", source: "scratch" }, // host-owned; tmpfs never claims it
  ];

  it("unconditionally drops only the tmpfs-owned scratch mounts", () => {
    // The in-kernel tmpfs is the unconditional authority for its scratch
    // prefixes, so the resolver always drops them. The image root and the
    // non-tmpfs `/run` scratch mount survive; every prefix the kernel serves is
    // gone so the host materialises no backend that could shadow it.
    const kept = filterMountSpecForKernelTmpfs(spec);
    expect(kept.map((m) => m.path)).toEqual(["/", "/run"]);
    for (const prefix of KERNEL_TMPFS_OWNED_PREFIXES) {
      expect(kept.some((m) => m.path === prefix)).toBe(false);
    }
  });

  it("preserves an image mount and a non-tmpfs scratch mount", () => {
    const preserved: MountSpec[] = [
      { path: "/", source: "image" },
      { path: "/run", source: "scratch" },
    ];
    expect(filterMountSpecForKernelTmpfs(preserved)).toEqual(preserved);
  });
});
