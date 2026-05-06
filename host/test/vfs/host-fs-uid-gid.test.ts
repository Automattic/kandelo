import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
});
