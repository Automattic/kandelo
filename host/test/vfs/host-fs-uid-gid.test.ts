import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, fstatSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../../src/vfs/host-fs";

describe("HostFileSystem uid/gid normalization", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wasm-posix-host-fs-uid-gid-"));
    writeFileSync(join(root, "file.txt"), "hi");
    mkdirSync(join(root, "sub"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The host's real uid/gid (e.g. macOS user 501) must not be exposed to
  // guest programs. Programs run with Process::new's default euid=0; the
  // backend reports uid=0/gid=0 so guests see host-mounted files as
  // self-owned. This satisfies tools that compare ownership against
  // their own euid (git's "dubious ownership" check, nginx config
  // ownership, etc.) without leaking the host uid.

  it("stat returns uid=0 gid=0 regardless of host's real uid", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.stat("/file.txt");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("lstat returns uid=0 gid=0", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.lstat("/file.txt");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("fstat returns uid=0 gid=0", () => {
    const hfs = new HostFileSystem(root);
    const fd = hfs.open("/file.txt", 0, 0);
    try {
      const st = hfs.fstat(fd);
      expect(st.uid).toBe(0);
      expect(st.gid).toBe(0);
    } finally {
      hfs.close(fd);
    }
  });

  it("stat on a directory also normalizes", () => {
    const hfs = new HostFileSystem(root);
    const st = hfs.stat("/sub");
    expect(st.uid).toBe(0);
    expect(st.gid).toBe(0);
  });

  it("chmod updates virtual mode without changing native mode", () => {
    const nativePath = join(root, "chmod.txt");
    writeFileSync(nativePath, "hi");
    chmodSync(nativePath, 0o600);
    const nativeBefore = statSync(nativePath).mode & 0o7777;

    const hfs = new HostFileSystem(root);
    hfs.chmod("/chmod.txt", 0o751);

    expect(hfs.stat("/chmod.txt").mode & 0o7777).toBe(0o751);
    expect(statSync(nativePath).mode & 0o7777).toBe(nativeBefore);
  });

  it("chown updates virtual owner without changing native owner", () => {
    const nativePath = join(root, "chown.txt");
    writeFileSync(nativePath, "hi");
    const nativeBefore = statSync(nativePath);

    const hfs = new HostFileSystem(root);
    hfs.chown("/chown.txt", 1234, 5678);

    const virtual = hfs.stat("/chown.txt");
    const nativeAfter = statSync(nativePath);
    expect(virtual.uid).toBe(1234);
    expect(virtual.gid).toBe(5678);
    expect(nativeAfter.uid).toBe(nativeBefore.uid);
    expect(nativeAfter.gid).toBe(nativeBefore.gid);
  });

  it("lchown updates only symlink metadata, including for dangling links", () => {
    const targetPath = join(root, "lchown-target.txt");
    const linkPath = join(root, "lchown-link");
    const danglingPath = join(root, "lchown-dangling");
    writeFileSync(targetPath, "target");
    symlinkSync("lchown-target.txt", linkPath);
    symlinkSync("missing-target", danglingPath);
    const nativeLinkBefore = lstatSync(linkPath);
    const nativeTargetBefore = statSync(targetPath);

    const hfs = new HostFileSystem(root);
    hfs.lchown("/lchown-link", 1234, 5678);
    hfs.lchown("/lchown-dangling", 2345, 6789);

    expect(hfs.lstat("/lchown-link")).toMatchObject({ uid: 1234, gid: 5678 });
    expect(hfs.stat("/lchown-link")).toMatchObject({ uid: 0, gid: 0 });
    expect(hfs.lstat("/lchown-dangling")).toMatchObject({ uid: 2345, gid: 6789 });
    expect(lstatSync(linkPath)).toMatchObject({
      uid: nativeLinkBefore.uid,
      gid: nativeLinkBefore.gid,
    });
    expect(statSync(targetPath)).toMatchObject({
      uid: nativeTargetBefore.uid,
      gid: nativeTargetBefore.gid,
    });
  });

  it("fchmod and fchown update virtual metadata without native changes", () => {
    const nativePath = join(root, "fd.txt");
    writeFileSync(nativePath, "hi");
    chmodSync(nativePath, 0o600);

    const hfs = new HostFileSystem(root);
    const fd = hfs.open("/fd.txt", 0, 0);
    try {
      const nativeBefore = fstatSync(fd);
      hfs.fchmod(fd, 0o700);
      hfs.fchown(fd, 2222, 3333);

      const virtual = hfs.fstat(fd);
      const nativeAfter = fstatSync(fd);
      expect(virtual.mode & 0o7777).toBe(0o700);
      expect(virtual.uid).toBe(2222);
      expect(virtual.gid).toBe(3333);
      expect(nativeAfter.mode & 0o7777).toBe(nativeBefore.mode & 0o7777);
      expect(nativeAfter.uid).toBe(nativeBefore.uid);
      expect(nativeAfter.gid).toBe(nativeBefore.gid);
    } finally {
      hfs.close(fd);
    }
  });
});
