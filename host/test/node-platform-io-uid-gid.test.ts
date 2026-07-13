import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, fstatSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePlatformIO } from "../src/platform/node";

describe("NodePlatformIO uid/gid normalization", () => {
  let dir: string;
  let file: string;
  let subdir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wasm-posix-node-platform-io-uid-gid-"));
    file = join(dir, "file.txt");
    subdir = join(dir, "sub");
    writeFileSync(file, "hi");
    mkdirSync(subdir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Mirrors the policy in HostFileSystem: uid/gid are normalized to 0
  // (matching Process::new's default euid) so guest programs see
  // host-backed files as self-owned. The real host uid (e.g. macOS user
  // 501) is not exposed to programs running through the kernel.

  it("stat returns uid=0 gid=0 regardless of host uid", () => {
    const io = new NodePlatformIO();
    const st = io.stat(file);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("lstat returns uid=0 gid=0", () => {
    const io = new NodePlatformIO();
    const st = io.lstat(file);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("fstat returns uid=0 gid=0", () => {
    const io = new NodePlatformIO();
    const fd = io.open(file, 0, 0);
    try {
      const st = io.fstat(fd);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(0);
    } finally {
      io.close(fd);
    }
  });

  it("stat on a directory also normalizes", () => {
    const io = new NodePlatformIO();
    const st = io.stat(subdir);
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("chmod updates virtual mode without changing native mode", () => {
    const p = join(dir, "chmod.txt");
    writeFileSync(p, "hi");
    chmodSync(p, 0o600);
    const nativeBefore = statSync(p).mode & 0o7777;

    const io = new NodePlatformIO();
    io.chmod(p, 0o751);

    expect(io.stat(p).mode & 0o7777).toBe(0o751);
    expect(statSync(p).mode & 0o7777).toBe(nativeBefore);
  });

  it("chown updates virtual owner without changing native owner", () => {
    const p = join(dir, "chown.txt");
    writeFileSync(p, "hi");
    const nativeBefore = statSync(p);

    const io = new NodePlatformIO();
    io.chown(p, 1234, 5678);

    const virtual = io.stat(p);
    const nativeAfter = statSync(p);
    expect(virtual.uid).toBe(1234);
    expect(virtual.gid).toBe(5678);
    expect(nativeAfter.uid).toBe(nativeBefore.uid);
    expect(nativeAfter.gid).toBe(nativeBefore.gid);
  });

  it("lchown updates only symlink metadata, including for dangling links", () => {
    const target = join(dir, "lchown-target.txt");
    const link = join(dir, "lchown-link");
    const dangling = join(dir, "lchown-dangling");
    writeFileSync(target, "target");
    symlinkSync(target, link);
    symlinkSync(join(dir, "missing-target"), dangling);
    const nativeLinkBefore = lstatSync(link);
    const nativeTargetBefore = statSync(target);

    const io = new NodePlatformIO();
    io.lchown(link, 1234, 5678);
    io.lchown(dangling, 2345, 6789);

    expect(io.lstat(link)).toMatchObject({ uid: 1234, gid: 5678 });
    expect(io.stat(link)).toMatchObject({ uid: 0, gid: 0 });
    expect(io.lstat(dangling)).toMatchObject({ uid: 2345, gid: 6789 });
    expect(lstatSync(link)).toMatchObject({
      uid: nativeLinkBefore.uid,
      gid: nativeLinkBefore.gid,
    });
    expect(statSync(target)).toMatchObject({
      uid: nativeTargetBefore.uid,
      gid: nativeTargetBefore.gid,
    });
  });

  it("fchmod and fchown update virtual metadata without native changes", () => {
    const p = join(dir, "fd.txt");
    writeFileSync(p, "hi");
    chmodSync(p, 0o600);

    const io = new NodePlatformIO();
    const fd = io.open(p, 0, 0);
    try {
      const nativeBefore = fstatSync(fd);
      io.fchmod(fd, 0o700);
      io.fchown(fd, 2222, 3333);

      const virtual = io.fstat(fd);
      const nativeAfter = fstatSync(fd);
      expect(virtual.mode & 0o7777).toBe(0o700);
      expect(virtual.uid).toBe(2222);
      expect(virtual.gid).toBe(3333);
      expect(nativeAfter.mode & 0o7777).toBe(nativeBefore.mode & 0o7777);
      expect(nativeAfter.uid).toBe(nativeBefore.uid);
      expect(nativeAfter.gid).toBe(nativeBefore.gid);
    } finally {
      io.close(fd);
    }
  });
});
