import { describe, it, expect, vi } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { ensureDirRecursive } from "../../src/vfs/image-helpers";
import {
  EEXIST,
  EBADF,
  EISDIR,
  EMFILE,
  ENOENT,
  ENOTDIR,
  MAX_FDS,
  O_DIRECTORY,
  O_EXCL,
  O_RDONLY,
  O_RDWR,
  SFSError,
  SharedFS,
} from "../../src/vfs/sharedfs-vendor";

// O_WRONLY | O_CREAT | O_TRUNC, matching sharedfs-vendor.ts constants.
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

// Inode layout from sharedfs-vendor.ts. Mirrored here so the test
// would catch a silent shift of the offset constants.
const INODE_SIZE = 128;
const INO_UID = 96;
const INO_GID = 100;

describe("SharedFS uid/gid", () => {
  it("new file has uid=0 gid=0 by default", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("stat surfaces non-zero uid/gid written to inode bytes", () => {
    // This test verifies the buildStat → adaptStat propagation path is
    // wired to the new INO_UID/INO_GID fields, not just hardcoded to 0.
    // Without this, the previous test would pass trivially against a
    // stub that returns {uid:0, gid:0}.
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);

    // Create a file with a unique mode so we can locate its inode bytes.
    const uniqueMode = 0o100631; // S_IFREG | 0o631 — unlikely to collide
    const fd = fs.open("/marker", O_WRONLY | O_CREAT | O_TRUNC, 0o631);
    fs.close(fd);

    // Sanity: the open above should have produced mode = S_IFREG | 0o631.
    const stPre = fs.stat("/marker");
    expect(stPre.mode).toBe(uniqueMode);
    expect(stPre.uid).toBe(0);
    expect(stPre.gid).toBe(0);

    // Locate the inode by scanning the SAB for the unique mode word.
    // INO_MODE = 8, so the mode lives at inodeOffset + 8.
    const view = new DataView(sab);
    let inodeOffset = -1;
    for (let off = 0; off + INODE_SIZE <= sab.byteLength; off += INODE_SIZE) {
      // mode is at byte 8 within the inode
      if (view.getUint32(off + 8, true) === uniqueMode) {
        // Verify it also looks like the right inode by checking link_count==1.
        if (view.getUint32(off + 12, true) === 1) {
          inodeOffset = off;
          break;
        }
      }
    }
    expect(inodeOffset).toBeGreaterThan(0);

    // Write non-zero uid/gid directly into the reserved bytes.
    view.setUint32(inodeOffset + INO_UID, 1234, true);
    view.setUint32(inodeOffset + INO_GID, 5678, true);

    // stat must surface them.
    const st = fs.stat("/marker");
    expect(st.uid).toBe(1234);
    expect(st.gid).toBe(5678);

    // fstat must surface them too.
    const fd2 = fs.open("/marker", 0 /* O_RDONLY */, 0);
    const stf = fs.fstat(fd2);
    fs.close(fd2);
    expect(stf.uid).toBe(1234);
    expect(stf.gid).toBe(5678);

    // lstat must surface them too.
    const stl = fs.lstat("/marker");
    expect(stl.uid).toBe(1234);
    expect(stl.gid).toBe(5678);
  });

  it("chown changes uid/gid", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.close(fd);
    fs.chown("/hello", 1000, 1000);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(1000);
    expect(st.gid).toBe(1000);
  });

  it("lchown changes a final symlink without changing its target", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/target", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.close(fd);
    fs.chown("/target", 100, 200);
    fs.symlink("/target", "/link");
    fs.symlink("/missing", "/dangling");

    fs.lchown("/link", 300, 400);
    fs.lchown("/dangling", 500, 600);

    expect(fs.lstat("/link")).toMatchObject({ uid: 300, gid: 400 });
    expect(fs.stat("/link")).toMatchObject({ uid: 100, gid: 200 });
    expect(fs.lstat("/dangling")).toMatchObject({ uid: 500, gid: 600 });
  });

  it("fchown changes uid/gid via fd", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.fchown(fd, 500, 600);
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(500);
    expect(st.gid).toBe(600);
  });

  it("chown-family operations clear set-ID bits on regular files", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const create = (path: string, mode: number): number =>
      fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);

    let fd = create("/path", 0o6755);
    fs.close(fd);
    fs.chown("/path", 1000, 1000);
    expect(fs.stat("/path").mode & 0o7777).toBe(0o755);

    fd = create("/fd", 0o6755);
    fs.fchown(fd, 1000, 1000);
    expect(fs.fstat(fd).mode & 0o7777).toBe(0o755);
    fs.close(fd);

    fd = create("/same-ids", 0o644);
    fs.close(fd);
    fs.chown("/same-ids", 1000, 2000);
    fs.chmod("/same-ids", 0o6755);
    fs.chown("/same-ids", 1000, 2000);
    expect(fs.stat("/same-ids").mode & 0o7777).toBe(0o755);

    fd = create("/uid-only", 0o644);
    fs.close(fd);
    fs.chown("/uid-only", 1000, 2000);
    fs.chmod("/uid-only", 0o6755);
    fs.chown("/uid-only", 3000, 0xffffffff);
    expect(fs.stat("/uid-only")).toMatchObject({ uid: 3000, gid: 2000 });
    expect(fs.stat("/uid-only").mode & 0o7777).toBe(0o755);

    fd = create("/gid-only", 0o644);
    fs.close(fd);
    fs.chown("/gid-only", 1000, 2000);
    fs.chmod("/gid-only", 0o6755);
    fs.chown("/gid-only", 0xffffffff, 3000);
    expect(fs.stat("/gid-only")).toMatchObject({ uid: 1000, gid: 3000 });
    expect(fs.stat("/gid-only").mode & 0o7777).toBe(0o755);

    fd = create("/group-executable", 0o6610);
    fs.close(fd);
    fs.chown("/group-executable", 1000, 1000);
    expect(fs.stat("/group-executable").mode & 0o7777).toBe(0o610);

    fd = create("/non-executable", 0o6600);
    fs.close(fd);
    fs.chown("/non-executable", 1000, 1000);
    expect(fs.stat("/non-executable").mode & 0o7777).toBe(0o600);

    fs.mkdir("/directory", 0o6770);
    fs.chown("/directory", 1000, 1000);
    expect(fs.stat("/directory").mode & 0o7777).toBe(0o6770);

    fs.chmod("/path", 0o6755);
    fs.symlink("/path", "/link");
    fs.lchown("/link", 2000, 2000);
    expect(fs.lstat("/link")).toMatchObject({ uid: 2000, gid: 2000 });
    expect(fs.stat("/path").mode & 0o7777).toBe(0o6755);
  });

  it("invalidates set-ID metadata after every qualifying file mutation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const path = "/mutation-matrix";
    const byte = new Uint8Array([0x78]);
    const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o6755);
    const expectMode = (mode: number): void => {
      expect(fs.stat(path).mode & 0o7777).toBe(mode);
      expect(fs.fstat(fd).mode & 0o7777).toBe(mode);
    };
    const arm = (mode = 0o6755): void => {
      fs.chmod(path, mode);
      expectMode(mode);
    };

    try {
      arm();
      expect(fs.write(fd, byte, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(fs.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(fs.append(fd, byte, 1, null).written).toBe(1);
      expectMode(0o755);

      arm();
      const truncateFd = fs.open(path, O_WRONLY | O_TRUNC, 0);
      fs.close(truncateFd);
      expectMode(0o755);

      expect(fs.write(fd, byte, 0, 1)).toBe(1);
      arm();
      fs.ftruncate(fd, 0);
      expectMode(0o755);

      arm();
      fs.chown(path, 1001, 2001);
      expectMode(0o755);

      arm();
      fs.fchown(fd, 1002, 2002);
      expectMode(0o755);

      arm();
      fs.lchown(path, 1003, 2003);
      expectMode(0o755);

      arm(0o6600);
      expect(fs.write(fd, byte, 0, 1)).toBe(1);
      expectMode(0o600);

      arm(0o6600);
      fs.chown(path, 1004, 2004);
      expectMode(0o600);

      arm();
      expect(fs.write(fd, byte, null, 0)).toBe(0);
      expect(fs.write(fd, byte, 0, 0)).toBe(0);
      expect(fs.append(fd, byte, 0, null).written).toBe(0);
      expectMode(0o6755);

      const unchangedSize = fs.fstat(fd).size;
      fs.ftruncate(fd, unchangedSize);
      expectMode(0o6755);
      if (unchangedSize !== 0) {
        fs.ftruncate(fd, 0);
        arm();
      }
      const emptyTruncateFd = fs.open(path, O_WRONLY | O_TRUNC, 0);
      fs.close(emptyTruncateFd);
      expectMode(0o6755);

      const readOnlyFd = fs.open(path, 0, 0);
      try {
        expect(() => fs.write(readOnlyFd, byte, null, 1)).toThrow();
        expect(() => fs.ftruncate(readOnlyFd, 0)).toThrow();
      } finally {
        fs.close(readOnlyFd);
      }
      expectMode(0o6755);
    } finally {
      fs.close(fd);
    }

    fs.mkdir("/mutation-directory", 0o6770);
    fs.chown("/mutation-directory", 3001, 3002);
    expect(fs.stat("/mutation-directory").mode & 0o7777).toBe(0o6770);
  });

  it("keeps mode coherent after positive and failed mutation attempts", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const path = "/mutation-failures";
    const bytes = new Uint8Array([0x78, 0x79]);
    const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
    const expectMode = (mode: number): void => {
      expect(fs.stat(path).mode & 0o7777).toBe(mode);
      expect(fs.fstat(fd).mode & 0o7777).toBe(mode);
    };
    const arm = (): void => {
      fs.chmod(path, 0o6755);
      expectMode(0o6755);
    };
    const expectFailure = (operation: () => unknown): void => {
      expect(operation).toThrow();
      expectMode(0o6755);
    };

    try {
      arm();
      expect(fs.write(fd, bytes, null, 1)).toBe(1);
      expectMode(0o755);

      arm();
      expect(fs.write(fd, bytes, 0, 1)).toBe(1);
      expectMode(0o755);

      arm();
      const limit = fs.fstat(fd).size + 1;
      expect(fs.append(fd, bytes, bytes.length, limit).written).toBe(1);
      expectMode(0o755);

      arm();
      const readOnlyFd = fs.open(path, 0, 0);
      try {
        expectFailure(() => fs.write(readOnlyFd, bytes, null, 1));
        expectFailure(() => fs.write(readOnlyFd, bytes, 0, 1));
        expectFailure(() => fs.append(readOnlyFd, bytes, 1, null));
        expectFailure(() => fs.ftruncate(readOnlyFd, 0));
      } finally {
        fs.close(readOnlyFd);
      }

      expectFailure(() => fs.open("/missing-truncate", O_WRONLY | O_TRUNC, 0));
      expectFailure(() => fs.chown("/missing-chown", 1000, 2000));
      expectFailure(() => fs.fchown(999_999, 1000, 2000));
      expectFailure(() => fs.lchown("/missing-lchown", 1000, 2000));
    } finally {
      fs.close(fd);
    }
  });

  it("leaves an armed file unchanged when O_TRUNC cannot reserve a descriptor", () => {
    const fs = SharedFS.mkfs(new SharedArrayBuffer(4 * 1024 * 1024));
    const path = "/emfile-truncate";
    const contents = new TextEncoder().encode("retain exact bytes");
    const fd = fs.open(path, O_CREAT | O_RDWR, 0o600);
    expect(fs.write(fd, contents)).toBe(contents.byteLength);
    fs.chown(path, 1234, 5678);
    fs.chmod(path, 0o6755);

    const fillers: number[] = [];
    try {
      for (let index = 1; index < MAX_FDS; index++) {
        fillers.push(fs.open(path, O_RDONLY, 0));
      }

      let failure: unknown;
      try {
        fs.open(path, O_RDWR | O_TRUNC, 0);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SFSError);
      expect((failure as SFSError).code).toBe(EMFILE);

      const pathStat = fs.stat(path);
      const fdStat = fs.fstat(fd);
      expect(pathStat).toMatchObject({
        size: contents.byteLength,
        uid: 1234,
        gid: 5678,
      });
      expect(fdStat).toMatchObject({
        size: contents.byteLength,
        uid: 1234,
        gid: 5678,
      });
      expect(pathStat.mode & 0o7777).toBe(0o6755);
      expect(fdStat.mode & 0o7777).toBe(0o6755);
      const observed = new Uint8Array(contents.byteLength);
      expect(fs.readAt(fd, observed, 0)).toBe(contents.byteLength);
      expect(observed).toEqual(contents);

      const released = fillers.shift()!;
      fs.close(released);
      const reused = fs.open(path, O_RDONLY, 0);
      expect(reused).toBe(released);
      fs.close(reused);
    } finally {
      for (const filler of fillers) fs.close(filler);
      fs.close(fd);
    }
  });

  it("accepts O_RDONLY | O_TRUNC and keeps the descriptor read-only", () => {
    const fs = SharedFS.mkfs(new SharedArrayBuffer(1024 * 1024));
    const path = "/read-only-truncate";
    const seed = fs.open(path, O_CREAT | O_RDWR, 0o600);
    expect(fs.write(seed, new TextEncoder().encode("truncate me"))).toBe(11);
    fs.close(seed);
    fs.chmod(path, 0o6755);

    const fd = fs.open(path, O_RDONLY | O_TRUNC, 0);
    try {
      expect(fs.stat(path).size).toBe(0);
      expect(fs.fstat(fd).size).toBe(0);
      expect(fs.stat(path).mode & 0o7777).toBe(0o755);
      expect(fs.fstat(fd).mode & 0o7777).toBe(0o755);
      expect(() => fs.write(fd, new Uint8Array([0x78]))).toThrow();
    } finally {
      fs.close(fd);
    }
  });

  it("releases the lowest reservation once after every pre-publish failure", () => {
    const fs = SharedFS.mkfs(new SharedArrayBuffer(4 * 1024 * 1024));
    const file = fs.open("/reservation-file", O_CREAT | O_RDWR, 0o600);
    fs.close(file);
    fs.mkdir("/reservation-directory", 0o700);

    const fillers: number[] = [];
    try {
      for (let index = 0; index < MAX_FDS - 1; index++) {
        fillers.push(fs.open("/reservation-file", O_RDONLY, 0));
      }
      const expectedFd = MAX_FDS - 1;
      const failures: Array<[() => unknown, number]> = [
        [() => fs.open("/missing", O_RDONLY, 0), ENOENT],
        [
          () => fs.open("/reservation-file", O_CREAT | O_EXCL | O_RDWR, 0),
          EEXIST,
        ],
        [() => fs.open("/reservation-file", O_DIRECTORY, 0), ENOTDIR],
        [() => fs.open("/reservation-directory", O_RDWR, 0), EISDIR],
      ];

      for (const [operation, code] of failures) {
        let failure: unknown;
        try {
          operation();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SFSError);
        expect((failure as SFSError).code).toBe(code);

        const probe = fs.open("/reservation-file", O_RDONLY, 0);
        expect(probe).toBe(expectedFd);
        fs.close(probe);
      }
    } finally {
      for (const filler of fillers) fs.close(filler);
    }
  });

  it("keeps a reentrant observer from seeing a reserved descriptor", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const fs = SharedFS.mkfs(sab);
    const observer = SharedFS.mount(sab);
    const internals = fs as unknown as {
      inodeAddOpenRef(ino: number): boolean;
    };
    const addOpenRef = internals.inodeAddOpenRef.bind(fs);
    let observedReservation = false;
    vi.spyOn(internals, "inodeAddOpenRef").mockImplementation((ino) => {
      let failure: unknown;
      try {
        observer.fstat(0);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SFSError);
      expect((failure as SFSError).code).toBe(EBADF);
      observedReservation = true;
      return addOpenRef(ino);
    });

    try {
      const fd = fs.open("/private-reservation", O_CREAT | O_RDWR, 0o600);
      expect(fd).toBe(0);
      expect(observedReservation).toBe(true);
      expect(observer.fstat(fd).mode & 0o7777).toBe(0o600);
      fs.close(fd);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("preserves IDs selected with the unchanged sentinels", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/sentinels", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.close(fd);

    fs.chown("/sentinels", 1000, 2000);
    fs.chown("/sentinels", 0xffffffff, 3000);
    expect(fs.stat("/sentinels")).toMatchObject({ uid: 1000, gid: 3000 });
    fs.chown("/sentinels", 4000, 0xffffffff);
    expect(fs.stat("/sentinels")).toMatchObject({ uid: 4000, gid: 3000 });
  });

  it("chown round-trips back to zero and leaves other inode fields intact", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/rt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.close(fd);

    const before = fs.stat("/rt");
    expect(before.uid).toBe(0);
    expect(before.gid).toBe(0);

    fs.chown("/rt", 7777, 8888);
    const mid = fs.stat("/rt");
    expect(mid.uid).toBe(7777);
    expect(mid.gid).toBe(8888);
    // chown must not disturb mode, link count, or size.
    expect(mid.mode).toBe(before.mode);
    expect(mid.linkCount).toBe(before.linkCount);
    expect(mid.size).toBe(before.size);

    fs.chown("/rt", 0, 0);
    const after = fs.stat("/rt");
    expect(after.uid).toBe(0);
    expect(after.gid).toBe(0);
    expect(after.mode).toBe(before.mode);
  });

  it("createFileWithOwner sets uid/gid at creation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    ensureDirRecursive(fs, "/etc");
    fs.createFileWithOwner(
      "/etc/passwd",
      0o644,
      0,
      0,
      new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
    );
    const st = fs.stat("/etc/passwd");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
    expect(st.mode & 0o777).toBe(0o644);
  });

  it("createFileWithOwner sets non-root uid/gid", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    fs.createFileWithOwner(
      "/data",
      0o600,
      4242,
      9999,
      new TextEncoder().encode("hello"),
    );
    const st = fs.stat("/data");
    expect(st.uid).toBe(4242);
    expect(st.gid).toBe(9999);
    expect(st.mode & 0o7777).toBe(0o600);
    expect(st.size).toBe(5);
  });

  it("preserves reviewed set-ID metadata until a later guest mutation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const bytes = new TextEncoder().encode("reviewed");
    fs.createFileWithOwner("/published", 0o6755, 0, 0, bytes);
    expect(fs.stat("/published")).toMatchObject({
      uid: 0,
      gid: 0,
      size: bytes.byteLength,
    });
    expect(fs.stat("/published").mode & 0o7777).toBe(0o6755);

    const fd = fs.open("/published", O_WRONLY, 0);
    try {
      expect(fs.write(fd, new Uint8Array([0x78]), null, 1)).toBe(1);
      expect(fs.fstat(fd).mode & 0o7777).toBe(0o755);
      expect(fs.stat("/published").mode & 0o7777).toBe(0o755);
    } finally {
      fs.close(fd);
    }
  });

  it("mkdirWithOwner sets uid/gid at creation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    ensureDirRecursive(fs, "/var");
    fs.mkdirWithOwner("/var/log", 0o755, 0, 0);
    const st = fs.stat("/var/log");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("symlinkWithOwner sets uid/gid at creation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    ensureDirRecursive(fs, "/usr/bin");
    fs.createFileWithOwner(
      "/usr/bin/sh",
      0o755,
      0,
      0,
      new TextEncoder().encode(""),
    );
    ensureDirRecursive(fs, "/bin");
    fs.symlinkWithOwner("/usr/bin/sh", "/bin/sh", 0, 0);
    const st = fs.lstat("/bin/sh");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("symlinkWithOwner does not follow symlinks (chowns the link, not target)", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    // target /nonexistent does NOT exist; symlinkWithOwner must succeed anyway
    fs.symlinkWithOwner("/nonexistent", "/mylink", 1234, 5678);
    const st = fs.lstat("/mylink");
    expect(st.uid).toBe(1234);
    expect(st.gid).toBe(5678);
  });
});
