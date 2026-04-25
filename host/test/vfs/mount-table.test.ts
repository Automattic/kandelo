import { describe, it, expect } from "vitest";
import { MountTable } from "../../src/vfs/mount-table";
import type { Backend } from "../../src/vfs/backends/backend-interface";

// Minimal Backend stub — we only need object identity for these tests,
// so every method throws. Tests check the routing, not behavior.
const stubBackend = (tag: string): Backend => ({
  open() { throw new Error(`${tag}.open`); },
  close() { throw new Error(`${tag}.close`); },
  read() { throw new Error(`${tag}.read`); },
  write() { throw new Error(`${tag}.write`); },
  seek() { throw new Error(`${tag}.seek`); },
  fstat() { throw new Error(`${tag}.fstat`); },
  ftruncate() { throw new Error(`${tag}.ftruncate`); },
  fsync() { throw new Error(`${tag}.fsync`); },
  fchmod() { throw new Error(`${tag}.fchmod`); },
  fchown() { throw new Error(`${tag}.fchown`); },
  stat() { throw new Error(`${tag}.stat`); },
  lstat() { throw new Error(`${tag}.lstat`); },
  mkdir() { throw new Error(`${tag}.mkdir`); },
  rmdir() { throw new Error(`${tag}.rmdir`); },
  unlink() { throw new Error(`${tag}.unlink`); },
  rename() { throw new Error(`${tag}.rename`); },
  link() { throw new Error(`${tag}.link`); },
  symlink() { throw new Error(`${tag}.symlink`); },
  readlink() { throw new Error(`${tag}.readlink`); },
  chmod() { throw new Error(`${tag}.chmod`); },
  chown() { throw new Error(`${tag}.chown`); },
  access() { throw new Error(`${tag}.access`); },
  utimensat() { throw new Error(`${tag}.utimensat`); },
  opendir() { throw new Error(`${tag}.opendir`); },
  readdir() { throw new Error(`${tag}.readdir`); },
  closedir() { throw new Error(`${tag}.closedir`); },
});

describe("MountTable.resolve", () => {
  it("returns null for paths not covered by any mount", () => {
    const t = new MountTable();
    t.register("/etc", stubBackend("etc"));
    expect(t.resolve("/usr/bin/foo")).toBeNull();
    expect(t.resolve("/")).toBeNull();
  });

  it("resolves exact mount-point match with subPath=/", () => {
    const t = new MountTable();
    const etc = stubBackend("etc");
    t.register("/etc", etc);
    const r = t.resolve("/etc");
    expect(r).not.toBeNull();
    expect(r!.entry.backend).toBe(etc);
    expect(r!.subPath).toBe("/");
  });

  it("resolves prefix match with correct subPath", () => {
    const t = new MountTable();
    const etc = stubBackend("etc");
    t.register("/etc", etc);
    const r = t.resolve("/etc/passwd")!;
    expect(r.entry.backend).toBe(etc);
    expect(r.subPath).toBe("/passwd");
  });

  it("does NOT match prefix-only (/etc must not cover /etcetera)", () => {
    const t = new MountTable();
    t.register("/etc", stubBackend("etc"));
    expect(t.resolve("/etcetera")).toBeNull();
    expect(t.resolve("/etcetera/foo")).toBeNull();
  });

  it("picks longest-prefix match when mounts nest", () => {
    const t = new MountTable();
    const usr = stubBackend("usr");
    const localBin = stubBackend("localBin");
    t.register("/usr", usr);
    t.register("/usr/local/bin", localBin);
    const r = t.resolve("/usr/local/bin/vim")!;
    expect(r.entry.backend).toBe(localBin);
    expect(r.subPath).toBe("/vim");

    const rOther = t.resolve("/usr/share/doc")!;
    expect(rOther.entry.backend).toBe(usr);
    expect(rOther.subPath).toBe("/share/doc");
  });

  it("root mount catches anything not claimed by a more specific mount", () => {
    const t = new MountTable();
    const root = stubBackend("root");
    const etc = stubBackend("etc");
    t.register("/", root);
    t.register("/etc", etc);
    expect(t.resolve("/etc/passwd")!.entry.backend).toBe(etc);
    expect(t.resolve("/anywhere/else")!.entry.backend).toBe(root);
    expect(t.resolve("/anywhere/else")!.subPath).toBe("/anywhere/else");
  });

  it("normalizes trailing slashes on mount paths", () => {
    const t = new MountTable();
    t.register("/tmp/", stubBackend("tmp"));
    expect(t.resolve("/tmp")!.subPath).toBe("/");
    expect(t.resolve("/tmp/foo")!.subPath).toBe("/foo");
  });

  it("rejects duplicate mount registration", () => {
    const t = new MountTable();
    t.register("/etc", stubBackend("a"));
    expect(() => t.register("/etc", stubBackend("b"))).toThrow(/already registered/);
    // Trailing slashes normalize to the same mount point
    expect(() => t.register("/etc/", stubBackend("c"))).toThrow(/already registered/);
  });

  it("rejects non-absolute mount paths", () => {
    const t = new MountTable();
    expect(() => t.register("etc", stubBackend("x"))).toThrow(/must be absolute/);
  });

  it("backendIndex reflects registration order", () => {
    const t = new MountTable();
    const a = stubBackend("a");
    const b = stubBackend("b");
    const c = stubBackend("c");
    t.register("/a", a);
    t.register("/b", b);
    t.register("/c", c);
    expect(t.resolve("/a/x")!.backendIndex).toBe(0);
    expect(t.resolve("/b/x")!.backendIndex).toBe(1);
    expect(t.resolve("/c/x")!.backendIndex).toBe(2);
  });
});
