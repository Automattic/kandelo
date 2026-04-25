import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { MemFsBackend } from "../../src/vfs/backends/memfs-backend";

function makeImage() {
  const sab = new SharedArrayBuffer(1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdirWithOwner("/etc", 0o755, 0, 0);
  mfs.createFileWithOwner(
    "/etc/passwd",
    0o644,
    0,
    0,
    new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
  );
  mfs.mkdirWithOwner("/root", 0o700, 0, 0);
  mfs.createFileWithOwner(
    "/root/.bashrc",
    0o600,
    0,
    0,
    new TextEncoder().encode("# bashrc\n"),
  );
  return mfs;
}

describe("MemFsBackend", () => {
  it("stats a file via sub-path with the mount prefix prepended", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const st = etc.stat("/passwd");
    expect(st.mode & 0o777).toBe(0o644);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("opens and reads a file through the sub-path translation", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const fd = etc.open("/passwd", 0, 0);
    const buf = new Uint8Array(64);
    const n = etc.read(fd, buf, null, buf.byteLength);
    etc.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toContain("root:x:0:0");
  });

  it("exact sub-path '/' addresses the backend's root (i.e. the MFS prefix dir)", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const st = etc.stat("/");
    expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("two backends over the same MFS expose disjoint subtrees", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const root = new MemFsBackend(mfs, "/root");

    const passwd = etc.stat("/passwd");
    expect(passwd.mode & 0o777).toBe(0o644);

    // /passwd is not a thing under /root
    expect(() => root.stat("/passwd")).toThrow();

    const bashrc = root.stat("/.bashrc");
    expect(bashrc.mode & 0o777).toBe(0o600);
  });

  it("empty prefix means the backend sees the MFS's full namespace", () => {
    const mfs = makeImage();
    const full = new MemFsBackend(mfs); // no prefix
    const st = full.stat("/etc/passwd");
    expect(st.mode & 0o777).toBe(0o644);
  });

  it("readdir returns sub-mount entry names (not re-prefixed)", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const h = etc.opendir("/");
    const names: string[] = [];
    while (true) {
      const e = etc.readdir(h);
      if (!e) break;
      if (e.name !== "." && e.name !== "..") names.push(e.name);
    }
    etc.closedir(h);
    expect(names.sort()).toEqual(["passwd"]);
  });

  it("writes through to the underlying MFS", () => {
    const mfs = makeImage();
    const etc = new MemFsBackend(mfs, "/etc");
    const fd = etc.open("/new-file", 0o1101, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
    etc.write(fd, new TextEncoder().encode("hello"), null, 5);
    etc.close(fd);
    // Directly via the underlying MFS — confirms the prefix was applied
    const st = mfs.stat("/etc/new-file");
    expect(st.mode & 0o777).toBe(0o644);
  });
});
