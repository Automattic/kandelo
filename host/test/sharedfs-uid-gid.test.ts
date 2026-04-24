import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

describe("SharedFS uid/gid", () => {
  it("new file has uid=0 gid=0 by default", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", 0o1101, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("chown changes uid/gid", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", 0o1101, 0o644);
    fs.close(fd);
    fs.chown("/hello", 1000, 1000);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(1000);
    expect(st.gid).toBe(1000);
  });

  it("fchown changes uid/gid via fd", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const fd = fs.open("/hello", 0o1101, 0o644);
    fs.fchown(fd, 500, 600);
    fs.close(fd);
    const st = fs.stat("/hello");
    expect(st.uid).toBe(500);
    expect(st.gid).toBe(600);
  });

  it("createFileWithOwner sets content, mode, and uid/gid at creation", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    const content = new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n");
    fs.mkdirWithOwner("/etc", 0o755, 0, 0);
    fs.createFileWithOwner("/etc/passwd", 0o644, 0, 0, content);
    const st = fs.stat("/etc/passwd");
    expect(st.mode & 0o777).toBe(0o644);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
    const buf = new Uint8Array(128);
    const fd = fs.open("/etc/passwd", 0, 0);
    const n = fs.read(fd, buf, null, buf.byteLength);
    fs.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("root:x:0:0:root:/root:/bin/sh\n");
  });

  it("mkdirWithOwner and symlinkWithOwner set uid/gid", () => {
    const sab = new SharedArrayBuffer(1024 * 1024);
    const fs = MemoryFileSystem.create(sab);
    fs.mkdirWithOwner("/var", 0o755, 10, 20);
    const dst = fs.stat("/var");
    expect(dst.mode & 0o777).toBe(0o755);
    expect(dst.uid).toBe(10);
    expect(dst.gid).toBe(20);

    fs.symlinkWithOwner("/etc/localtime-target", "/etc-link", 30, 40);
    const lst = fs.lstat("/etc-link");
    expect(lst.uid).toBe(30);
    expect(lst.gid).toBe(40);
  });
});
