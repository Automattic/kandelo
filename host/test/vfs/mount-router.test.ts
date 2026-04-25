import { describe, it, expect } from "vitest";
import { MountTable } from "../../src/vfs/mount-table";
import { MountRouter, type HostServices } from "../../src/vfs/mount-router";
import type { Backend } from "../../src/vfs/backends/backend-interface";
import type { StatResult } from "../../src/types";

// Recording backend — every method pushes its arguments onto a log so
// tests can assert routing behavior.
class RecordingBackend implements Backend {
  log: string[] = [];
  private nextHandle = 1;

  constructor(public readonly tag: string) {}

  // ── Handle-based ──
  open(p: string, _f: number, _m: number): number {
    this.log.push(`${this.tag}.open(${p})`);
    return this.nextHandle++;
  }
  close(h: number): number { this.log.push(`${this.tag}.close(${h})`); return 0; }
  read(h: number, _b: Uint8Array, _o: number | null, l: number): number {
    this.log.push(`${this.tag}.read(${h})`); return l;
  }
  write(h: number, _b: Uint8Array, _o: number | null, l: number): number {
    this.log.push(`${this.tag}.write(${h})`); return l;
  }
  seek(h: number, o: number, _w: number): number { this.log.push(`${this.tag}.seek(${h})`); return o; }
  fstat(h: number): StatResult {
    this.log.push(`${this.tag}.fstat(${h})`);
    return { dev: 0, ino: h, mode: 0o100644, nlink: 1, uid: 1000, gid: 1000, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  ftruncate(h: number, _l: number): void { this.log.push(`${this.tag}.ftruncate(${h})`); }
  fsync(h: number): void { this.log.push(`${this.tag}.fsync(${h})`); }
  fchmod(h: number, _m: number): void { this.log.push(`${this.tag}.fchmod(${h})`); }
  fchown(h: number, _u: number, _g: number): void { this.log.push(`${this.tag}.fchown(${h})`); }

  // ── Path-based ──
  stat(p: string): StatResult {
    this.log.push(`${this.tag}.stat(${p})`);
    return { dev: 0, ino: 99, mode: 0o100644, nlink: 1, uid: 42, gid: 43, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  lstat(p: string): StatResult {
    this.log.push(`${this.tag}.lstat(${p})`);
    return { dev: 0, ino: 99, mode: 0o120777, nlink: 1, uid: 42, gid: 43, size: 0, atimeMs: 0, mtimeMs: 0, ctimeMs: 0 };
  }
  mkdir(p: string, _m: number): void { this.log.push(`${this.tag}.mkdir(${p})`); }
  rmdir(p: string): void { this.log.push(`${this.tag}.rmdir(${p})`); }
  unlink(p: string): void { this.log.push(`${this.tag}.unlink(${p})`); }
  rename(o: string, n: string): void { this.log.push(`${this.tag}.rename(${o}→${n})`); }
  link(o: string, n: string): void { this.log.push(`${this.tag}.link(${o}→${n})`); }
  symlink(t: string, p: string): void { this.log.push(`${this.tag}.symlink(${t}→${p})`); }
  readlink(p: string): string { this.log.push(`${this.tag}.readlink(${p})`); return "target"; }
  chmod(p: string, _m: number): void { this.log.push(`${this.tag}.chmod(${p})`); }
  chown(p: string, _u: number, _g: number): void { this.log.push(`${this.tag}.chown(${p})`); }
  access(p: string, _m: number): void { this.log.push(`${this.tag}.access(${p})`); }
  utimensat(p: string, _as: number, _an: number, _ms: number, _mn: number): void {
    this.log.push(`${this.tag}.utimensat(${p})`);
  }
  opendir(p: string): number { this.log.push(`${this.tag}.opendir(${p})`); return this.nextHandle++; }
  readdir(_h: number): null { return null; }
  closedir(h: number): void { this.log.push(`${this.tag}.closedir(${h})`); }
}

const stubServices = (): HostServices => ({
  clockGettime: () => ({ sec: 123, nsec: 456 }),
  nanosleep: () => {},
});

function setup() {
  const etc = new RecordingBackend("etc");
  const tmp = new RecordingBackend("tmp");
  const t = new MountTable();
  t.register("/etc", etc);
  t.register("/tmp", tmp);
  const r = new MountRouter(t, stubServices());
  return { etc, tmp, r };
}

describe("MountRouter", () => {
  it("routes path-based ops to the right backend and strips the mount prefix", () => {
    const { etc, tmp, r } = setup();
    r.stat("/etc/passwd");
    r.stat("/tmp/foo");
    expect(etc.log).toContain("etc.stat(/passwd)");
    expect(tmp.log).toContain("tmp.stat(/foo)");
  });

  it("returns ENOENT for unmounted paths", () => {
    const { r } = setup();
    expect(() => r.stat("/usr/bin/foo")).toThrow(/ENOENT/);
    expect(() => r.open("/nope", 0, 0)).toThrow(/ENOENT/);
  });

  it("tags handles by backend index and routes back correctly", () => {
    const { etc, tmp, r } = setup();
    const fdEtc = r.open("/etc/passwd", 0, 0);
    const fdTmp = r.open("/tmp/foo", 0, 0);

    // Different backend tags mean different high bits
    expect(fdEtc).not.toBe(fdTmp);
    expect(fdEtc >>> 28).toBe(0); // etc was registered first
    expect(fdTmp >>> 28).toBe(1);

    r.read(fdEtc, new Uint8Array(1), null, 1);
    r.read(fdTmp, new Uint8Array(1), null, 1);
    expect(etc.log).toContain("etc.read(1)"); // local handle 1
    expect(tmp.log).toContain("tmp.read(1)"); // local handle 1

    r.close(fdEtc);
    r.close(fdTmp);
    expect(etc.log).toContain("etc.close(1)");
    expect(tmp.log).toContain("tmp.close(1)");
  });

  it("throws EXDEV on cross-backend rename and link", () => {
    const { r } = setup();
    expect(() => r.rename("/etc/passwd", "/tmp/passwd")).toThrow(/EXDEV/);
    expect(() => r.link("/etc/passwd", "/tmp/passwd")).toThrow(/EXDEV/);
  });

  it("rename within the same backend forwards correctly", () => {
    const { etc, r } = setup();
    r.rename("/etc/a", "/etc/b");
    expect(etc.log).toContain("etc.rename(/a→/b)");
  });

  it("fstat on a tagged handle routes to the right backend", () => {
    const { tmp, r } = setup();
    const fd = r.open("/tmp/foo", 0, 0);
    const st = r.fstat(fd);
    expect(st.ino).toBe(fd & 0x0fffffff); // recording backend returns the local handle
    expect(tmp.log).toContain("tmp.fstat(1)");
  });

  it("EBADF for an unknown backend tag", () => {
    const { r } = setup();
    const bogus = (5 << 28) | 42;
    expect(() => r.close(bogus)).toThrow(/EBADF/);
  });

  it("exact mount-point path gets subPath=/", () => {
    const { etc, r } = setup();
    r.stat("/etc");
    expect(etc.log).toContain("etc.stat(/)");
  });

  it("non-FS ops delegate to HostServices", () => {
    const { r } = setup();
    expect(r.clockGettime(0)).toEqual({ sec: 123, nsec: 456 });
  });

  it("readdir on a tagged dir handle routes through", () => {
    const { etc, r } = setup();
    const h = r.opendir("/etc");
    r.closedir(h);
    expect(etc.log).toContain("etc.opendir(/)");
    expect(etc.log).toContain("etc.closedir(1)");
  });
});
