import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

// Verify uid/gid survive the VFS image serialization boundary. Phase 3
// loads rootfs.vfs into a MemoryFileSystem and routes syscalls through
// it; if uid/gid didn't round-trip through saveImage/fromImage, the
// rootfs would load with everything owned by uid=0/gid=0 regardless of
// the manifest. This test is the load-bearing guarantee for that path.

describe("MemoryFileSystem uid/gid image round-trip", () => {
  it("preserves uid/gid across saveImage → fromImage", async () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    fs.mkdirWithOwner("/etc", 0o755, 0, 0);
    fs.createFileWithOwner(
      "/etc/passwd",
      0o644,
      0,
      0,
      new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
    );
    fs.mkdirWithOwner("/home", 0o755, 0, 0);
    fs.mkdirWithOwner("/home/alice", 0o700, 1000, 1000);
    fs.createFileWithOwner(
      "/home/alice/notes.txt",
      0o600,
      1000,
      1000,
      new TextEncoder().encode("private\n"),
    );

    const image = await fs.saveImage();

    const restored = MemoryFileSystem.fromImage(image);
    const etc = restored.stat("/etc");
    expect(etc.uid).toBe(0);
    expect(etc.gid).toBe(0);
    expect(etc.mode & 0o777).toBe(0o755);

    const passwd = restored.stat("/etc/passwd");
    expect(passwd.uid).toBe(0);
    expect(passwd.gid).toBe(0);
    expect(passwd.mode & 0o777).toBe(0o644);

    const alice = restored.stat("/home/alice");
    expect(alice.uid).toBe(1000);
    expect(alice.gid).toBe(1000);
    expect(alice.mode & 0o777).toBe(0o700);

    const notes = restored.stat("/home/alice/notes.txt");
    expect(notes.uid).toBe(1000);
    expect(notes.gid).toBe(1000);
    expect(notes.mode & 0o777).toBe(0o600);

    // Content also survives
    const fd = restored.open("/home/alice/notes.txt", 0, 0);
    const buf = new Uint8Array(64);
    const n = restored.read(fd, buf, null, buf.byteLength);
    restored.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("private\n");
  });

  it("chown + stat round-trip via MemoryFileSystem as syscall backend", () => {
    // Directly exercises the PlatformIO-facing path: the kernel's
    // sys_chown / sys_stat invoke PlatformIO.chown / PlatformIO.stat,
    // which for memfs-owned paths land on these MemoryFileSystem
    // methods. Previous (pre-Phase-0) code hardcoded uid/gid=0 in
    // adaptStat; this test guards against that regression.
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    fs.mkdirWithOwner("/var", 0o755, 0, 0);
    fs.createFileWithOwner("/var/log", 0o644, 0, 0, new Uint8Array());

    // Simulate kernel: call chown then stat.
    fs.chown("/var/log", 33, 33);
    const st = fs.stat("/var/log");
    expect(st.uid).toBe(33);
    expect(st.gid).toBe(33);

    // fchown via open fd too.
    const fd = fs.open("/var/log", 0, 0);
    fs.fchown(fd, 500, 500);
    const fst = fs.fstat(fd);
    fs.close(fd);
    expect(fst.uid).toBe(500);
    expect(fst.gid).toBe(500);
  });
});
