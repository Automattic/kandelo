import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { HostFileSystem } from "../src/vfs/host-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  BLOCK_SIZE,
  EMFILE,
  FD_ENTRY_SIZE,
  FD_TABLE_OFFSET,
  MAX_FDS,
  O_CREAT,
  O_RDONLY,
  O_RDWR,
  O_TRUNC,
  SFSError,
} from "../src/vfs/sharedfs-vendor";
import { NodeTimeProvider } from "../src/vfs/time";
import type { FileSystemBackend, MountConfig } from "../src/vfs/types";
import type { StatResult, StatfsResult } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBackend(): FileSystemBackend & { calls: string[] } {
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
    const hfs = new HostFileSystem("/tmp/sandbox");
    expect(() => hfs.stat("/../../../etc/passwd")).toThrow("EACCES");
  });

  it("rejects paths with embedded .. sequences", () => {
    const hfs = new HostFileSystem("/tmp/sandbox");
    expect(() => hfs.stat("/subdir/../../etc/passwd")).toThrow("EACCES");
  });
});

// ---------------------------------------------------------------------------
// 5. MemoryFileSystem round-trip
// ---------------------------------------------------------------------------

describe("MemoryFileSystem", () => {
  it("creates, writes, seeks, and reads back a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/test.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("hello world");
    const written = mfs.write(fd, data, null, data.length);
    expect(written).toBe(data.length);
    mfs.seek(fd, 0, 0); // SEEK_SET
    const buf = new Uint8Array(32);
    const bytesRead = mfs.read(fd, buf, null, 32);
    expect(bytesRead).toBe(data.length);
    expect(new TextDecoder().decode(buf.subarray(0, bytesRead))).toBe(
      "hello world",
    );
    mfs.close(fd);
  });

  it("does not restore a stale descriptor offset after positioned I/O", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const fd = mfs.open("/positional.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("0123456789");
    mfs.write(fd, data, null, data.length);
    mfs.seek(fd, 2, 0);

    const sharedFs = (mfs as any).fs;
    const originalRead = sharedFs.read.bind(sharedFs);
    const originalPread = sharedFs.pread.bind(sharedFs);
    const originalWrite = sharedFs.write.bind(sharedFs);
    const originalPwrite = sharedFs.pwrite.bind(sharedFs);

    sharedFs.read = (readFd: number, buffer: Uint8Array) => {
      const n = originalRead(readFd, buffer);
      if (readFd === fd) sharedFs.lseek(fd, 7, 0);
      return n;
    };
    sharedFs.pread = (readFd: number, buffer: Uint8Array, offset: number) => {
      const n = originalPread(readFd, buffer, offset);
      if (readFd === fd) sharedFs.lseek(fd, 7, 0);
      return n;
    };

    const readBuf = new Uint8Array(2);
    expect(mfs.read(fd, readBuf, 4, readBuf.length)).toBe(2);
    expect(new TextDecoder().decode(readBuf)).toBe("45");
    expect(mfs.seek(fd, 0, 1)).toBe(7);

    sharedFs.read = originalRead;
    sharedFs.pread = originalPread;
    mfs.seek(fd, 3, 0);

    sharedFs.write = (writeFd: number, buffer: Uint8Array) => {
      const n = originalWrite(writeFd, buffer);
      if (writeFd === fd) sharedFs.lseek(fd, 8, 0);
      return n;
    };
    sharedFs.pwrite = (
      writeFd: number,
      buffer: Uint8Array,
      offset: number,
    ) => {
      const n = originalPwrite(writeFd, buffer, offset);
      if (writeFd === fd) sharedFs.lseek(fd, 8, 0);
      return n;
    };

    const patch = new TextEncoder().encode("xy");
    expect(mfs.write(fd, patch, 5, patch.length)).toBe(2);
    expect(mfs.seek(fd, 0, 1)).toBe(8);

    sharedFs.write = originalWrite;
    sharedFs.pwrite = originalPwrite;
    const finalBuf = new Uint8Array(data.length);
    expect(mfs.read(fd, finalBuf, 0, finalBuf.length)).toBe(data.length);
    expect(new TextDecoder().decode(finalBuf)).toBe("01234xy789");
    mfs.close(fd);
  });

  it("opens more than the old 64-descriptor SharedFS table limit", () => {
    expect(MAX_FDS).toBe(
      Math.floor((BLOCK_SIZE - FD_TABLE_OFFSET) / FD_ENTRY_SIZE),
    );
    expect(MAX_FDS).toBeGreaterThan(64);

    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const createFd = mfs.open(
      "/many-fds.txt",
      O_CREAT | O_RDWR | O_TRUNC,
      0o644,
    );
    mfs.close(createFd);

    const fds: number[] = [];
    try {
      for (let i = 0; i < 65; i++) {
        fds.push(mfs.open("/many-fds.txt", O_RDONLY, 0o644));
      }
      expect(new Set(fds).size).toBe(65);
      expect(Math.max(...fds)).toBeGreaterThanOrEqual(64);
    } finally {
      for (const fd of fds) mfs.close(fd);
    }
  });

  it("throws EMFILE when the derived SharedFS fd table is full", () => {
    expect(MAX_FDS).toBeLessThanOrEqual(160);

    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const createFd = mfs.open(
      "/fd-limit.txt",
      O_CREAT | O_RDWR | O_TRUNC,
      0o644,
    );
    mfs.close(createFd);

    const fds: number[] = [];
    let error: unknown;
    try {
      for (let i = 0; i < MAX_FDS; i++) {
        fds.push(mfs.open("/fd-limit.txt", O_RDONLY, 0o644));
      }
      const unexpectedFd = mfs.open("/fd-limit.txt", O_RDONLY, 0o644);
      fds.push(unexpectedFd);
    } catch (err) {
      error = err;
    } finally {
      for (const fd of fds) mfs.close(fd);
    }

    expect(error).toBeInstanceOf(SFSError);
    expect((error as SFSError).code).toBe(EMFILE);
  });

  it("creates and lists directories", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    mfs.mkdir("/mydir", 0o755);
    // Create a file in the dir
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/mydir/file.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    // List dir
    const dh = mfs.opendir("/mydir");
    const entries: string[] = [];
    let entry;
    while ((entry = mfs.readdir(dh)) !== null) {
      entries.push(entry.name);
    }
    mfs.closedir(dh);
    expect(entries).toContain("file.txt");
  });

  it("stat returns correct size after writing", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/sized.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("12345");
    mfs.write(fd, data, null, data.length);
    const st = mfs.fstat(fd);
    expect(st.size).toBe(5);
    mfs.close(fd);
  });

  it("unlink removes a file", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_WRONLY = 0x0001;
    const fd = mfs.open("/todelete.txt", O_CREAT | O_WRONLY, 0o644);
    mfs.close(fd);
    mfs.unlink("/todelete.txt");
    expect(() => mfs.stat("/todelete.txt")).toThrow();
  });

  it("keeps unlinked open files alive until the last close", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const fd = mfs.open("/temp.db", O_CREAT | O_RDWR | O_TRUNC, 0o600);
    const original = enc.encode("sqlite-temp-content");
    mfs.write(fd, original, null, original.length);

    mfs.unlink("/temp.db");
    expect(() => mfs.stat("/temp.db")).toThrow();

    const replacementFd = mfs.open(
      "/replacement.db",
      O_CREAT | O_RDWR | O_TRUNC,
      0o600,
    );
    const replacement = enc.encode("replacement");
    mfs.write(replacementFd, replacement, null, replacement.length);

    mfs.seek(fd, 0, 0);
    const readBack = new Uint8Array(original.length);
    expect(mfs.read(fd, readBack, null, readBack.length)).toBe(original.length);
    expect(dec.decode(readBack)).toBe("sqlite-temp-content");

    mfs.seek(fd, original.length, 0);
    const suffix = enc.encode("-after-unlink");
    mfs.write(fd, suffix, null, suffix.length);
    expect(mfs.fstat(fd).size).toBe(original.length + suffix.length);

    mfs.seek(replacementFd, 0, 0);
    const replacementRead = new Uint8Array(replacement.length);
    expect(
      mfs.read(replacementFd, replacementRead, null, replacementRead.length),
    ).toBe(replacement.length);
    expect(dec.decode(replacementRead)).toBe("replacement");

    mfs.close(replacementFd);
    mfs.close(fd);
    expect(() => mfs.stat("/temp.db")).toThrow();
  });

  it("keeps renamed-over open files alive until the last close", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const destFd = mfs.open("/dest.db", O_CREAT | O_RDWR | O_TRUNC, 0o600);
    const dest = enc.encode("open-destination");
    mfs.write(destFd, dest, null, dest.length);

    const srcFd = mfs.open("/src.db", O_CREAT | O_RDWR | O_TRUNC, 0o600);
    const src = enc.encode("replacement-source");
    mfs.write(srcFd, src, null, src.length);
    mfs.close(srcFd);

    mfs.rename("/src.db", "/dest.db");

    mfs.seek(destFd, 0, 0);
    const destRead = new Uint8Array(dest.length);
    expect(mfs.read(destFd, destRead, null, destRead.length)).toBe(dest.length);
    expect(dec.decode(destRead)).toBe("open-destination");

    const newDestFd = mfs.open("/dest.db", O_RDONLY, 0);
    const srcRead = new Uint8Array(src.length);
    expect(mfs.read(newDestFd, srcRead, null, srcRead.length)).toBe(src.length);
    expect(dec.decode(srcRead)).toBe("replacement-source");

    mfs.close(newDestFd);
    mfs.close(destFd);
    expect(() => mfs.stat("/src.db")).toThrow();
  });

  it("ftruncate changes file size", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const O_CREAT = 0x0040,
      O_RDWR = 0x0002,
      O_TRUNC = 0x0200;
    const fd = mfs.open("/trunc.txt", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("abcdefghij");
    mfs.write(fd, data, null, data.length);
    expect(mfs.fstat(fd).size).toBe(10);
    mfs.ftruncate(fd, 5);
    expect(mfs.fstat(fd).size).toBe(5);
    mfs.close(fd);
  });

  it("statfs reports real SharedFS block usage", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs = MemoryFileSystem.create(sab);
    const before = mfs.statfs("/");
    const fd = mfs.open("/blocks.bin", 0x0040 | 0x0002 | 0x0200, 0o644);
    const data = new Uint8Array(8192);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);
    const after = mfs.statfs("/");
    expect(after.blocks).toBe(before.blocks);
    expect(after.bfree).toBeLessThan(before.bfree);
    expect(after.bavail).toBe(after.bfree);
  });

  it("statfs reports effective max capacity for growable filesystems", () => {
    const initialBytes = 1 * 1024 * 1024;
    const maxBytes = 8 * 1024 * 1024;
    const sab = new SharedArrayBuffer(initialBytes, {
      maxByteLength: maxBytes,
    });
    const mfs = MemoryFileSystem.create(sab, maxBytes);

    const before = mfs.statfs("/");
    expect(before.blocks * before.bsize).toBe(maxBytes);
    expect(before.bfree).toBeGreaterThan(initialBytes / before.bsize);
    expect(sab.byteLength).toBe(initialBytes);

    const fd = mfs.open("/grow.bin", 0x0040 | 0x0002 | 0x0200, 0o644);
    const data = new Uint8Array(initialBytes);
    expect(mfs.write(fd, data, null, data.length)).toBe(data.length);
    mfs.close(fd);

    const after = mfs.statfs("/");
    expect(sab.byteLength).toBeGreaterThan(initialBytes);
    expect(after.blocks).toBe(before.blocks);
    expect(after.blocks * after.bsize).toBe(maxBytes);
    expect(after.bfree).toBeLessThan(before.bfree);
    expect(after.bavail).toBe(after.bfree);
  });

  it("statfs does not report the internal default growth cap for non-growable buffers", () => {
    const initialBytes = 1 * 1024 * 1024;
    const sab = new SharedArrayBuffer(initialBytes);
    const mfs = MemoryFileSystem.create(sab);
    const stats = mfs.statfs("/");

    expect(stats.blocks * stats.bsize).toBe(initialBytes);
    expect(sab.maxByteLength).toBe(initialBytes);
  });
});

// ---------------------------------------------------------------------------
// 6. Mixed mounts test (HostFileSystem + MemoryFileSystem)
// ---------------------------------------------------------------------------

describe("Mixed mounts: HostFileSystem root + MemoryFileSystem /tmp", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vfs-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes via /tmp (memory) and reads via / (host) independently", () => {
    const hostFs = new HostFileSystem(tmpDir);
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const memFs = MemoryFileSystem.create(sab);

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

    const dh = vfs.opendir("/");
    const names: string[] = [];
    let entry;
    while ((entry = vfs.readdir(dh)) !== null) {
      names.push(entry.name);
    }
    vfs.closedir(dh);

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
// 7. VirtualPlatformIO with no mounts throws
// ---------------------------------------------------------------------------

describe("VirtualPlatformIO constructor validation", () => {
  it("throws if no mounts provided", () => {
    expect(() => new VirtualPlatformIO([], new NodeTimeProvider())).toThrow(
      "at least one mount",
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
});
