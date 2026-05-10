import { describe, it, expect, beforeEach } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { VirtualPlatformIO } from "../../src/vfs/vfs";
import type { MountConfig, TimeProvider } from "../../src/vfs/types";

// Linux musl open-flag bits — match what `host_open` receives from the kernel.
const O_RDONLY = 0o0;
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;

const noopTime: TimeProvider = {
  clockGettime: () => ({ sec: 0, nsec: 0 }),
  nanosleep: () => {},
};

function makeMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(256 * 1024);
  return MemoryFileSystem.create(sab);
}

function seedFile(fs: MemoryFileSystem, path: string, content: string): void {
  const data = new TextEncoder().encode(content);
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  fs.write(fd, data, null, data.length);
  fs.close(fd);
}

describe("VirtualPlatformIO readonly mount enforcement", () => {
  let roBackend: MemoryFileSystem;
  let rwBackend: MemoryFileSystem;
  let io: VirtualPlatformIO;

  beforeEach(() => {
    roBackend = makeMemfs();
    seedFile(roBackend, "/seed.txt", "hello");
    roBackend.mkdir("/a", 0o755);
    seedFile(roBackend, "/a/inner.txt", "inner");

    rwBackend = makeMemfs();

    const mounts: MountConfig[] = [
      { mountPoint: "/", backend: roBackend, readonly: true },
      { mountPoint: "/scratch", backend: rwBackend },
    ];
    io = new VirtualPlatformIO(mounts, noopTime);
  });

  it("rejects open(O_WRONLY) on readonly mount with EROFS", () => {
    expect(() => io.open("/seed.txt", O_WRONLY, 0)).toThrow(/EROFS/);
  });

  it("rejects open(O_RDWR) on readonly mount with EROFS", () => {
    expect(() => io.open("/seed.txt", O_RDWR, 0)).toThrow(/EROFS/);
  });

  it("rejects open(O_CREAT) on readonly mount with EROFS", () => {
    expect(() => io.open("/new.txt", O_CREAT, 0o644)).toThrow(/EROFS/);
  });

  it("rejects open(O_TRUNC) on readonly mount with EROFS", () => {
    expect(() => io.open("/seed.txt", O_TRUNC, 0)).toThrow(/EROFS/);
  });

  it("permits open(O_RDONLY) on readonly mount", () => {
    const fd = io.open("/seed.txt", O_RDONLY, 0);
    expect(fd).toBeGreaterThan(0);
    const buf = new Uint8Array(16);
    const n = io.read(fd, buf, null, buf.length);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("hello");
    io.close(fd);
  });

  it("rejects unlink on readonly mount with EROFS", () => {
    expect(() => io.unlink("/seed.txt")).toThrow(/EROFS/);
  });

  it("rejects mkdir on readonly mount with EROFS", () => {
    expect(() => io.mkdir("/newdir", 0o755)).toThrow(/EROFS/);
  });

  it("rejects rmdir on readonly mount with EROFS", () => {
    expect(() => io.rmdir("/a")).toThrow(/EROFS/);
  });

  it("rejects chmod on readonly mount with EROFS", () => {
    expect(() => io.chmod("/seed.txt", 0o600)).toThrow(/EROFS/);
  });

  it("rejects chown on readonly mount with EROFS", () => {
    expect(() => io.chown("/seed.txt", 1000, 1000)).toThrow(/EROFS/);
  });

  it("rejects symlink on readonly mount with EROFS", () => {
    expect(() => io.symlink("/seed.txt", "/sym")).toThrow(/EROFS/);
  });

  it("rejects utimensat on readonly mount with EROFS", () => {
    expect(() => io.utimensat("/seed.txt", 0, 0, 0, 0)).toThrow(/EROFS/);
  });

  it("rejects rename FROM readonly mount with EROFS (not EXDEV)", () => {
    // Pre-seed a destination on the writable mount so a same-backend
    // rename couldn't succeed without crossing devices either way.
    expect(() => io.rename("/seed.txt", "/scratch/moved.txt")).toThrow(
      /EROFS/,
    );
  });

  it("rejects rename TO readonly mount with EROFS (not EXDEV)", () => {
    seedFile(rwBackend, "/from.txt", "x");
    expect(() => io.rename("/scratch/from.txt", "/dest.txt")).toThrow(/EROFS/);
  });

  it("rejects link to a readonly destination mount with EROFS", () => {
    seedFile(rwBackend, "/src.txt", "x");
    expect(() => io.link("/scratch/src.txt", "/dst.txt")).toThrow(/EROFS/);
  });

  it("rejects fd-based write on readonly mount with EROFS", () => {
    const fd = io.open("/seed.txt", O_RDONLY, 0);
    const buf = new TextEncoder().encode("nope");
    expect(() => io.write(fd, buf, null, buf.length)).toThrow(/EROFS/);
    io.close(fd);
  });

  it("rejects fd-based ftruncate / fchmod / fchown on readonly mount", () => {
    const fd = io.open("/seed.txt", O_RDONLY, 0);
    expect(() => io.ftruncate(fd, 0)).toThrow(/EROFS/);
    expect(() => io.fchmod(fd, 0o600)).toThrow(/EROFS/);
    expect(() => io.fchown(fd, 1000, 1000)).toThrow(/EROFS/);
    io.close(fd);
  });

  it("permits read-only ops (stat/lstat/access/readdir) on readonly mount", () => {
    const st = io.stat("/seed.txt");
    expect(st.size).toBe(5);
    expect(() => io.access("/seed.txt", 4)).not.toThrow();
    const dh = io.opendir("/a");
    const e = io.readdir(dh);
    expect(e).not.toBeNull();
    io.closedir(dh);
  });

  it("permits writes on a non-readonly mount", () => {
    const fd = io.open("/scratch/new.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    const data = new TextEncoder().encode("hello scratch");
    const n = io.write(fd, data, null, data.length);
    expect(n).toBe(data.length);
    io.close(fd);
    io.mkdir("/scratch/sub", 0o755);
    expect(() => io.unlink("/scratch/new.txt")).not.toThrow();
  });

  it("permits writes via a writable overlay over a readonly mount", () => {
    // Mirrors the CA-cert injection layout: writable scratch shadows a
    // narrow subtree of a readonly root mount.
    const overlay = makeMemfs();
    const layered = new VirtualPlatformIO(
      [
        { mountPoint: "/", backend: roBackend, readonly: true },
        { mountPoint: "/a/overlay", backend: overlay },
      ],
      noopTime,
    );
    // Write through the longer-prefix mount succeeds.
    const fd = layered.open(
      "/a/overlay/cert.pem",
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    const data = new TextEncoder().encode("PEM");
    layered.write(fd, data, null, data.length);
    layered.close(fd);
    // Read-back via the same VFS path.
    const rfd = layered.open("/a/overlay/cert.pem", O_RDONLY, 0);
    const buf = new Uint8Array(16);
    const n = layered.read(rfd, buf, null, buf.length);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("PEM");
    layered.close(rfd);
    // A sibling path on the readonly mount stays read-only.
    expect(() =>
      layered.open("/a/inner.txt", O_WRONLY, 0),
    ).toThrow(/EROFS/);
  });

  it("preserves ENOENT (no fall-through) when path is unmounted", () => {
    // No mount above /nope exists in our fixture — expect ENOENT, not EROFS.
    const bare = new VirtualPlatformIO(
      [{ mountPoint: "/scratch", backend: rwBackend }],
      noopTime,
    );
    expect(() => bare.open("/nope/file.txt", O_RDONLY, 0)).toThrow(/ENOENT/);
  });
});
