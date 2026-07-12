import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../../src/vfs/host-fs";

const O_WRONLY = 0o1;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const UTIME_OMIT = 0x3ffffffe;

describe("HostFileSystem component-wise path resolution", () => {
  let top: string;
  let root: string;
  let outside: string;
  let hostFs: HostFileSystem;

  beforeEach(() => {
    top = mkdtempSync(join(tmpdir(), "kandelo-host-fs-path-"));
    root = join(top, "root");
    outside = join(top, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    hostFs = new HostFileSystem(root, "/mnt");
  });

  afterEach(() => {
    rmSync(top, { recursive: true, force: true });
  });

  it("allows ordinary names beginning with two dots and resolves components in order", () => {
    writeFileSync(join(root, "..visible"), "visible");
    mkdirSync(join(root, "existing"));
    writeFileSync(join(root, "existing", "file"), "data");

    expect(hostFs.stat("/..visible").size).toBe(7);
    expect(() => hostFs.stat("/existing/missing/../file")).toThrow(/ENOENT/);
  });

  it("follows normal relative and in-mount absolute symlinks", () => {
    writeFileSync(join(root, "target.txt"), "target");
    symlinkSync("target.txt", join(root, "relative-link"));
    symlinkSync("/mnt/target.txt", join(root, "absolute-link"));

    expect(hostFs.stat("/relative-link").size).toBe(6);
    expect(hostFs.stat("/absolute-link").size).toBe(6);
    expect(hostFs.readlink("/relative-link")).toBe("target.txt");

    hostFs.unlink("/relative-link");
    expect(existsSync(join(root, "relative-link"))).toBe(false);
    expect(existsSync(join(root, "target.txt"))).toBe(true);
  });

  it("does not follow a final symlink for an exclusive create", () => {
    symlinkSync("created-through-link", join(root, "exclusive-link"));

    expect(() =>
      hostFs.open("/exclusive-link", O_WRONLY | O_CREAT | O_EXCL, 0o600),
    ).toThrow(/EEXIST/);
    expect(existsSync(join(root, "created-through-link"))).toBe(false);
  });

  it("does not follow a dangling final symlink for mkdir", () => {
    symlinkSync("created-directory", join(root, "directory-link"));

    expect(() => hostFs.mkdir("/directory-link", 0o755)).toThrow(/EEXIST/);
    expect(existsSync(join(root, "created-directory"))).toBe(false);
  });

  it("does not follow a dangling hard-link destination", () => {
    writeFileSync(join(root, "source"), "source");
    symlinkSync("created-hard-link", join(root, "destination-link"));

    expect(() => hostFs.link("/source", "/destination-link")).toThrow(/EEXIST/);
    expect(existsSync(join(root, "created-hard-link"))).toBe(false);
  });

  it("keeps native link semantics for a symlink source inside the mount", () => {
    writeFileSync(join(root, "target"), "target");
    symlinkSync("target", join(root, "source-link"));

    hostFs.link("/source-link", "/linked-symlink");

    const sourceLink = hostFs.lstat("/source-link");
    const target = hostFs.stat("/target");
    const linked = hostFs.lstat("/linked-symlink");
    expect([sourceLink.ino, target.ino]).toContain(linked.ino);
    if ((linked.mode & 0xf000) === 0xa000) {
      expect(hostFs.readlink("/linked-symlink")).toBe("target");
    } else {
      expect(linked.ino).toBe(target.ino);
    }
  });

  it("revalidates an intermediate directory after an external replacement", () => {
    mkdirSync(join(root, "cached"));
    writeFileSync(join(root, "cached", "inside"), "inside");
    writeFileSync(join(outside, "secret"), "outside-secret");

    expect(hostFs.stat("/cached/inside").size).toBe(6);
    renameSync(join(root, "cached"), join(root, "old-cached"));
    symlinkSync(outside, join(root, "cached"));

    expect(() => hostFs.stat("/cached/secret")).toThrow(/EACCES/);
  });
});

describe("HostFileSystem utimens metadata", () => {
  let root: string;
  let hostFs: HostFileSystem;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kandelo-host-fs-utimens-"));
    hostFs = new HostFileSystem(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves an omitted timestamp", () => {
    const nativePath = join(root, "timestamps");
    writeFileSync(nativePath, "data");
    utimesSync(nativePath, 10, 20);
    const before = statSync(nativePath);

    hostFs.utimensat("/timestamps", 0, UTIME_OMIT, 30, 0);

    const result = hostFs.stat("/timestamps");
    expect(result.atimeMs).toBe(before.atimeMs);
    expect(result.mtimeMs).toBe(30_000);
  });

  it("drops timestamp overrides after an external native mutation", () => {
    const nativePath = join(root, "externally-mutated");
    writeFileSync(nativePath, "before");
    hostFs.utimensat("/externally-mutated", 1, 0, 2, 0);
    expect(hostFs.stat("/externally-mutated").mtimeMs).toBe(2_000);

    writeFileSync(nativePath, "after external mutation");
    const nativeAfter = statSync(nativePath);

    expect(hostFs.stat("/externally-mutated").mtimeMs).toBe(
      nativeAfter.mtimeMs,
    );
  });
});
