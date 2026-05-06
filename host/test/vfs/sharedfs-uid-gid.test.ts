import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { ensureDirRecursive } from "../../src/vfs/image-helpers";

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
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBe(5);
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
