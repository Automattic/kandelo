import { afterAll, describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
// The open flags from the generated ABI. Everything else this file used to
// take from `sharedfs-vendor.ts` — `BLOCK_SIZE`, `EMFILE`, `FD_ENTRY_SIZE`,
// `FD_TABLE_OFFSET`, `MAX_FDS`, `SFSError` — went with the 25 cases below that
// were about a `SharedArrayBuffer` filesystem's internals.
import { OPEN_FLAGS } from "../src/generated/abi";

const { O_CREAT, O_RDONLY, O_RDWR } = OPEN_FLAGS;

/**
 * A backend for `VirtualPlatformIO` to route to. These suites assert ROUTING —
 * which mount answered, how handles map, when a rename is EXDEV — and never
 * which filesystem did the answering, so what they need is a
 * `FileSystemBackend` that exists.
 */
const backendRoots: string[] = [];
function hostBackend(): HostFileSystem {
  const root = mkdtempSync(join(tmpdir(), "kandelo-vfs-backend-"));
  backendRoots.push(root);
  const fs = new HostFileSystem(root);
  // `mkdtemp` makes its directory 0o700 and a host-backed mount reports the
  // real mode, so a guest that is not the creating user cannot traverse `/`.
  fs.chmod("/", 0o755);
  return fs;
}

afterAll(() => {
  while (backendRoots.length > 0) {
    rmSync(backendRoots.pop()!, { recursive: true, force: true });
  }
});
import { NodeTimeProvider } from "../src/vfs/time";
import {
  ST_NOSUID,
  type FileSystemBackend,
  type MountConfig,
} from "../src/vfs/types";
import type { StatResult, StatfsResult } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(
  statOverrides: Partial<StatResult> = {},
): FileSystemBackend & { calls: string[] } {
  const calls: string[] = [];
  const dummyStat: StatResult = {
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    size: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    ...statOverrides,
  };
  const dummyStatfs: StatfsResult = {
    type: 0,
    bsize: 4096,
    blocks: 0,
    bfree: 0,
    bavail: 0,
    files: 0,
    ffree: 0,
    fsid: 0,
    namelen: 255,
    frsize: 4096,
    flags: 0,
  };
  return {
    calls,
    open: (path, flags, mode) => {
      calls.push(`open:${path}`);
      return 1;
    },
    close: (h) => {
      calls.push(`close:${h}`);
      return 0;
    },
    read: (h, buf, off, len) => {
      calls.push(`read:${h}`);
      return 0;
    },
    write: (h, buf, off, len) => {
      calls.push(`write:${h}`);
      return 0;
    },
    seek: (h, off, w) => {
      calls.push(`seek:${h}`);
      return 0;
    },
    fstat: (h) => {
      calls.push(`fstat:${h}`);
      return { ...dummyStat };
    },
    fpathconf: (h, name) => {
      calls.push(`fpathconf:${h}:${name}`);
      return 4096;
    },
    ftruncate: (h, l) => {
      calls.push(`ftruncate:${h}`);
    },
    fsync: (h) => {
      calls.push(`fsync:${h}`);
    },
    fchmod: (h, m) => {
      calls.push(`fchmod:${h}`);
    },
    fchown: (h, u, g) => {
      calls.push(`fchown:${h}`);
    },
    stat: (p) => {
      calls.push(`stat:${p}`);
      return { ...dummyStat };
    },
    lstat: (p) => {
      calls.push(`lstat:${p}`);
      return { ...dummyStat };
    },
    statfs: (p) => {
      calls.push(`statfs:${p}`);
      return { ...dummyStatfs };
    },
    pathconf: (p, name) => {
      calls.push(`pathconf:${p}:${name}`);
      return 4096;
    },
    mkdir: (p, m) => {
      calls.push(`mkdir:${p}`);
    },
    rmdir: (p) => {
      calls.push(`rmdir:${p}`);
    },
    unlink: (p) => {
      calls.push(`unlink:${p}`);
    },
    rename: (o, n) => {
      calls.push(`rename:${o}:${n}`);
    },
    link: (e, n) => {
      calls.push(`link:${e}:${n}`);
    },
    symlink: (t, p) => {
      calls.push(`symlink:${t}:${p}`);
    },
    readlink: (p) => {
      calls.push(`readlink:${p}`);
      return "";
    },
    chmod: (p, m) => {
      calls.push(`chmod:${p}`);
    },
    chown: (p, u, g) => {
      calls.push(`chown:${p}`);
    },
    lchown: (p, u, g) => {
      calls.push(`lchown:${p}`);
    },
    access: (p, m) => {
      calls.push(`access:${p}`);
    },
    utimensat: (p, aSec, aNsec, mSec, mNsec) => {
      calls.push(`utimensat:${p}`);
    },
    opendir: (p) => {
      calls.push(`opendir:${p}`);
      return 1;
    },
    readdir: (h) => {
      calls.push(`readdir:${h}`);
      return null;
    },
    closedir: (h) => {
      calls.push(`closedir:${h}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Mount resolution tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO mount resolution", () => {
  it("honors set-ID mode bits when nosuid is omitted", () => {
    const root = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }],
      new NodeTimeProvider(),
    );

    expect(vfs.statfs("/bin/tool").flags & ST_NOSUID).toBe(0);
  });

  it("routes root-level paths to the / mount", () => {
    const root = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: root }],
      new NodeTimeProvider(),
    );
    vfs.stat("/etc/hosts");
    expect(root.calls).toContain("stat:/etc/hosts");
  });

  it("routes /tmp paths to the /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/foo");
    expect(tmp.calls).toContain("stat:/foo");
    expect(root.calls).not.toContain("stat:/tmp/foo");
  });

  it("routes lchown by the final link pathname rather than its target", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.lchown("/tmp/link-to-root", 123, 456);

    expect(tmp.calls).toContain("lchown:/link-to-root");
    expect(root.calls).not.toContain("lchown:/tmp/link-to-root");
  });

  it("does not route /home/foo to /tmp mount", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/home/foo");
    expect(root.calls).toContain("stat:/home/foo");
    expect(tmp.calls.length).toBe(0);
  });

  it("longest prefix wins: /tmp/data beats /tmp", () => {
    const tmp = createMockBackend();
    const tmpData = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
        { mountPoint: "/tmp/data", backend: tmpData },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/data/file.csv");
    expect(tmpData.calls).toContain("stat:/file.csv");
    expect(tmp.calls.length).toBe(0);
  });

  it("exact mount-point path routes correctly", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp");
    expect(tmp.calls).toContain("stat:/");
  });

  it("strips trailing slashes from mount points", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp/", backend: tmp },
      ],
      new NodeTimeProvider(),
    );
    vfs.stat("/tmp/abc");
    expect(tmp.calls).toContain("stat:/abc");
  });
});

describe("VirtualPlatformIO file identity", () => {
  it("qualifies stat, lstat, and fstat device IDs by backend object", () => {
    const localDevice = (1n << 60n) + 17n;
    const root = createMockBackend();
    const first = createMockBackend({ dev: localDevice, ino: 2n });
    const second = createMockBackend({ dev: localDevice, ino: 2n });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
      ],
      new NodeTimeProvider(),
    );

    const firstStat = vfs.stat("/first/file");
    const secondStat = vfs.stat("/second/file");
    expect(typeof firstStat.dev).toBe("bigint");
    expect(firstStat.dev).not.toBe(secondStat.dev);
    expect(vfs.lstat("/first/file").dev).toBe(firstStat.dev);

    const handle = vfs.open("/first/file", O_RDONLY, 0);
    expect(vfs.fstat(handle).dev).toBe(firstStat.dev);
    vfs.close(handle);
  });

  it("shares qualified device IDs across alias mounts of one backend", () => {
    const root = createMockBackend();
    const shared = createMockBackend({
      dev: (1n << 60n) + 23n,
      ino: 9n,
    });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/one", backend: shared },
        { mountPoint: "/two", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/one/alias").dev).toBe(vfs.stat("/two/alias").dev);
  });

  it("keeps distinct backend-local devices distinct within one backend", () => {
    const root = createMockBackend();
    const shared = createMockBackend();
    const stat = shared.stat.bind(shared);
    shared.stat = (path) => ({
      ...stat(path),
      dev: path === "/first" ? (1n << 60n) + 31n : (1n << 60n) + 32n,
    });
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/shared", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.stat("/shared/first").dev).not.toBe(
      vfs.stat("/shared/second").dev,
    );
  });

  it("rejects imprecise numeric inode identities", () => {
    const backend = createMockBackend({
      dev: 1,
      ino: Number.MAX_SAFE_INTEGER + 1,
    });
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    expect(() => vfs.stat("/unsafe-inode")).toThrow(/EOVERFLOW: st_ino/);
  });

  it("qualifies colliding inode numbers by backend", () => {
    const root = createMockBackend();
    const first = createMockBackend();
    const second = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/first", backend: first },
        { mountPoint: "/second", backend: second },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/first/file", 0n, 2n)).not.toBe(
      vfs.fileIdentity("/second/file", 0n, 2n),
    );
  });

  it("uses one namespace when the same backend is mounted twice", () => {
    const root = createMockBackend();
    const shared = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/one", backend: shared },
        { mountPoint: "/two", backend: shared },
      ],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/one/alias", 0n, 7n)).toBe(
      vfs.fileIdentity("/two/alias", 0n, 7n),
    );
  });

  it("rejects a backend that supplies no stable inode", () => {
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: createMockBackend() }],
      new NodeTimeProvider(),
    );

    expect(vfs.fileIdentity("/file", 0n, 0n)).toBeNull();
  });

  it("derives identity from live handles after unlink and rename", () => {
    const backend = hostBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const unlinked = vfs.open("/unlinked", O_CREAT | O_RDWR, 0o600);
    const unlinkedStat = vfs.fstat(unlinked);
    const unlinkedIdentity = vfs.fileHandleIdentity(
      unlinked,
      BigInt(unlinkedStat.dev),
      BigInt(unlinkedStat.ino),
    );
    expect(unlinkedIdentity).not.toBeNull();
    vfs.unlink("/unlinked");
    expect(vfs.fileHandleIdentity(
      unlinked,
      BigInt(unlinkedStat.dev),
      BigInt(unlinkedStat.ino),
    )).toBe(unlinkedIdentity);

    const renamed = vfs.open("/before", O_CREAT | O_RDWR, 0o600);
    const renamedStat = vfs.fstat(renamed);
    const renamedIdentity = vfs.fileHandleIdentity(
      renamed,
      BigInt(renamedStat.dev),
      BigInt(renamedStat.ino),
    );
    expect(renamedIdentity).not.toBeNull();
    vfs.rename("/before", "/after");
    expect(vfs.fileHandleIdentity(
      renamed,
      BigInt(renamedStat.dev),
      BigInt(renamedStat.ino),
    )).toBe(renamedIdentity);

    vfs.close(unlinked);
    vfs.close(renamed);
  });
});

// ---------------------------------------------------------------------------
// 2. Handle mapping tests
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO handle mapping", () => {
  it("returns unique global handles that map to backend-local handles", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h1 = vfs.open("/a", 0, 0);
    const h2 = vfs.open("/b", 0, 0);

    expect(h1).not.toBe(h2);
    // Both should have delegated to backend.open
    expect(backend.calls.filter((c) => c.startsWith("open:"))).toHaveLength(2);
  });

  it("delegates read/write/seek to the correct backend via handle", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    const hRoot = vfs.open("/etc/file", 0, 0);
    const hTmp = vfs.open("/tmp/file", 0, 0);

    const buf = new Uint8Array(8);
    vfs.read(hRoot, buf, null, 8);
    vfs.write(hTmp, buf, null, 8);

    expect(root.calls).toContain("read:1");
    expect(tmp.calls).toContain("write:1");
    // The other backend should not see cross-traffic
    expect(root.calls.filter((c) => c.startsWith("write:"))).toHaveLength(0);
    expect(tmp.calls.filter((c) => c.startsWith("read:"))).toHaveLength(0);
  });

  it("close removes handle mapping; reuse errors", () => {
    const backend = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend }],
      new NodeTimeProvider(),
    );

    const h = vfs.open("/file", 0, 0);
    vfs.close(h);

    expect(() => vfs.read(h, new Uint8Array(4), null, 4)).toThrow("EBADF");
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-mount EXDEV test
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO cross-mount rename (EXDEV)", () => {
  it("throws EXDEV when renaming across mounts", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.rename("/tmp/a", "/home/b")).toThrow("EXDEV");
  });

  it("succeeds when renaming within the same mount", () => {
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: createMockBackend() },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.rename("/tmp/a", "/tmp/b");
    expect(tmp.calls).toContain("rename:/a:/b");
  });

  it("throws EXDEV for cross-mount link", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    expect(() => vfs.link("/tmp/a", "/home/b")).toThrow("EXDEV");
  });
});

// ---------------------------------------------------------------------------
// 4. Path traversal guard (HostFileSystem)
// ---------------------------------------------------------------------------

describe("HostFileSystem path traversal", () => {
  it("rejects paths that escape rootPath", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-host-fs-traversal-"));
    try {
      const hfs = new HostFileSystem(root);
      expect(() => hfs.stat("/../../../etc/passwd")).toThrow("EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths with embedded .. sequences", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-host-fs-traversal-"));
    try {
      mkdirSync(join(root, "subdir"));
      const hfs = new HostFileSystem(root);
      expect(() => hfs.stat("/subdir/../../etc/passwd")).toThrow("EACCES");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. MemoryFileSystem round-trip — RETIRED 2026-09-17, 25 cases
// ---------------------------------------------------------------------------
//
// The class was the SUBJECT here, and it is being deleted. The claims did not
// all go the same way, which is why they were audited one at a time rather
// than dropped together.
//
// TWELVE ARE ASSERTED IN RUST, on the filesystem that now serves these paths.
// `crates/runtime-core/src/tmpfs.rs` carries `create_write_read_roundtrip`,
// `mkdir_and_readdir`, `o_excl_rejects_existing`, `o_trunc_clears_content`,
// `open_missing_without_creat_is_enoent`, `rename_moves_replaces_and_guards`,
// `rmdir_nonempty_is_enotempty`, `truncate_grows_and_shrinks`,
// `timestamps_track_create_write_and_utimensat`, `chmod_chown_update_metadata`,
// `unlink_while_open_keeps_data_until_last_close` and
// `opening_a_directory_as_file_is_eisdir` — and the set-ID pair is
// `write_and_truncate_clear_setid_only_on_real_modification` plus
// `chown_clears_setid_for_unprivileged_caller`.
//
// SEVEN DESCRIBE AN ARCHITECTURE THE PLATFORM NO LONGER HAS: the 64-entry
// SharedFS descriptor table and its EMFILE, large-directory indexes coherent
// ACROSS SharedFS INSTANCES, raw inode numbers surviving slot reuse, and the
// three `statfs` cases about block accounting and growable-buffer caps. Every
// one is a property of a fixed `SharedArrayBuffer` allocation shared between
// workers. The kernel is one authority over owned Rust memory: there is no
// second instance to stay coherent with and no fixed block pool to account.
//
// THE REST WERE ROUTING CASES WEARING A FILESYSTEM'S NAME — the ones that
// "route ... through VirtualPlatformIO" — and they live on above, against a
// backend the platform still ships.

// ---------------------------------------------------------------------------
// 6. Nested mounts over SEPARATE backends
// ---------------------------------------------------------------------------
//
// Was "Mixed mounts: HostFileSystem root + MemoryFileSystem /tmp", and the
// mixing was never the claim. What these three assert is that a nested mount
// is a separate store — a write under `/tmp` does not appear under `/`,
// `readdir` and `statfs` reach the mount that owns the path — and two
// `HostFileSystem` instances rooted at different directories make exactly
// that point. The second backend TYPE went with `memory-fs.ts`; the second
// backend did not.

describe("Nested mounts over separate backends", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vfs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes via /tmp and reads via / independently", () => {
    const hostFs = new HostFileSystem(tmpDir);
    const memFs = hostBackend();

    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: hostFs },
        { mountPoint: "/tmp", backend: memFs },
      ],
      new NodeTimeProvider(),
    );

    // Write a file to /tmp (memory-backed)
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const hMem = vfs.open("/tmp/memfile.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const memData = new TextEncoder().encode("memory data");
    vfs.write(hMem, memData, null, memData.length);
    vfs.close(hMem);

    // Write a file to / (host-backed)
    writeFileSync(join(tmpDir, "hostfile.txt"), "host data");

    // Read back from host via VFS
    const hHost = vfs.open("/hostfile.txt", 0, 0);
    const buf = new Uint8Array(64);
    const n = vfs.read(hHost, buf, null, 64);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("host data");
    vfs.close(hHost);

    // Read back from memory via VFS
    const hMem2 = vfs.open("/tmp/memfile.txt", 0, 0);
    const buf2 = new Uint8Array(64);
    const n2 = vfs.read(hMem2, buf2, null, 64);
    expect(new TextDecoder().decode(buf2.subarray(0, n2))).toBe("memory data");
    vfs.close(hMem2);
  });

  it("directory listing works for host-backed mount", () => {
    writeFileSync(join(tmpDir, "a.txt"), "a");
    writeFileSync(join(tmpDir, "b.txt"), "b");

    const hostFs = new HostFileSystem(tmpDir);
    const vfs = new VirtualPlatformIO(
      [{ mountPoint: "/", backend: hostFs }],
      new NodeTimeProvider(),
    );

    // The kernel reaches a host directory through an anchor this host
    // published, then one component at a time. `"."` names the anchor itself.
    const O_DIRECTORY = 0o200000;
    const root = vfs.foreignMountRoots().find((r) => r.prefix === "/")!.handle;
    const dh = vfs.openat(root, ".", O_DIRECTORY, 0);
    const names: string[] = [];
    let entry;
    while ((entry = vfs.readdir(dh)) !== null) {
      names.push(entry.name);
    }
    vfs.close(dh);

    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("routes statfs to the mounted backend", () => {
    const root = createMockBackend();
    const tmp = createMockBackend();
    const vfs = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: root },
        { mountPoint: "/tmp", backend: tmp },
      ],
      new NodeTimeProvider(),
    );

    vfs.statfs("/tmp/file.txt");

    expect(root.calls).not.toContain("statfs:/tmp/file.txt");
    expect(tmp.calls).toContain("statfs:/file.txt");
  });
});

// ---------------------------------------------------------------------------
// 7. VirtualPlatformIO with no mounts
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO constructor validation", () => {
  // REVERSED 2026-09-13: this asserted a throw. Zero mounts is now the
  // DESTINATION rather than a mistake — the kernel owns `/`, every scratch
  // prefix, and since POSIX shared memory moved in-kernel, the whole of
  // `/dev`. On Node, `/dev/shm` was the last mount keeping the list non-empty,
  // and the guard turned "the kernel owns everything" into a boot failure.
  it("accepts no mounts, because the kernel may own every path", () => {
    const io = new VirtualPlatformIO([], new NodeTimeProvider());

    // The mistake the constructor guard used to catch is still caught, at the
    // moment it matters and with the path it could not route named.
    expect(() => io.open("/etc/passwd", 0, 0)).toThrow(
      /no mount for path: \/etc\/passwd/,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Time provider tests
// ---------------------------------------------------------------------------

describe("NodeTimeProvider", () => {
  it("returns realtime clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(0);
    expect(sec).toBeGreaterThan(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeLessThan(1_000_000_000);
  });

  it("returns monotonic clock", () => {
    const tp = new NodeTimeProvider();
    const { sec, nsec } = tp.clockGettime(1);
    expect(sec).toBeGreaterThanOrEqual(0);
    expect(nsec).toBeGreaterThanOrEqual(0);
  });

  it("monotonic clock is non-decreasing across calls", () => {
    const tp = new NodeTimeProvider();
    const t1 = tp.clockGettime(1);
    const t2 = tp.clockGettime(1);
    const ns1 = BigInt(t1.sec) * 1_000_000_000n + BigInt(t1.nsec);
    const ns2 = BigInt(t2.sec) * 1_000_000_000n + BigInt(t2.nsec);
    expect(ns2).toBeGreaterThanOrEqual(ns1);
  });

  it("treats CLOCK_BOOTTIME as monotonic-equivalent", () => {
    const tp = new NodeTimeProvider();
    const monotonic = tp.clockGettime(1);
    const boottime = tp.clockGettime(7);
    const monotonicNs = BigInt(monotonic.sec) * 1_000_000_000n + BigInt(monotonic.nsec);
    const boottimeNs = BigInt(boottime.sec) * 1_000_000_000n + BigInt(boottime.nsec);
    expect(boottimeNs).toBeGreaterThanOrEqual(monotonicNs);
    expect(boottimeNs - monotonicNs).toBeLessThan(100_000_000n);
  });
});
