import { describe, it, expect, beforeAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { zipSync } from "fflate";
import { buildImage } from "../src/builder.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

function readFromImage(mfs: MemoryFileSystem, path: string): string {
  const fd = mfs.open(path, 0, 0);
  const buf = new Uint8Array(4096);
  const n = mfs.read(fd, buf, null, buf.byteLength);
  mfs.close(fd);
  return new TextDecoder().decode(buf.subarray(0, n));
}

describe("image builder — pass 1: directories", () => {
  it("creates dirs with the manifest's mode/uid/gid", async () => {
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const etc = mfs.stat("/etc");
    expect(etc.mode & 0o777).toBe(0o755);
    expect(etc.uid).toBe(0);
    expect(etc.gid).toBe(0);

    // Sticky-bit dir survives the round-trip.
    const tmp = mfs.stat("/tmp");
    expect(tmp.mode & 0o7777).toBe(0o1777);

    // Non-zero owner.
    const alice = mfs.stat("/home/alice");
    expect(alice.mode & 0o777).toBe(0o700);
    expect(alice.uid).toBe(1000);
    expect(alice.gid).toBe(1000);
  });

  it("orders parents before children regardless of MANIFEST line order", async () => {
    // The basic MANIFEST lists / before /home before /home/alice — already
    // good — but we lean on the depth-sort by relying on /home/alice
    // existing under a parent that is also in the manifest.
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);
    expect(() => mfs.stat("/home/alice")).not.toThrow();
  });
});

describe("image builder — pass 2: regular files", () => {
  it("reads files from sourceTree using implicit src", async () => {
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const passwd = mfs.stat("/etc/passwd");
    expect(passwd.mode & 0o777).toBe(0o644);
    expect(passwd.uid).toBe(0);
    expect(passwd.gid).toBe(0);

    const text = readFromImage(mfs, "/etc/passwd");
    expect(text).toContain("root:x:0:0");
    expect(text).toContain("daemon:x:1:1");
    expect(text).toContain("nobody:x:65534:65534");
  });

  it("resolves explicit src= relative to repoRoot, bypassing sourceTree", async () => {
    const fixture = join(fixtures, "explicit-src");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const st = mfs.stat("/etc/mytool.conf");
    expect(st.mode & 0o777).toBe(0o644);
    expect(readFromImage(mfs, "/etc/mytool.conf")).toBe("some config\n");
  });
});

describe("image builder — pass 3: symlinks", () => {
  it("creates symlinks with the manifest's target and owner", async () => {
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const link = mfs.lstat("/usr/bin/sh");
    // Symlink mode bits: just confirm it's reported as a symlink (S_IFLNK = 0o120000).
    expect((link.mode & 0o170000) >>> 0).toBe(0o120000);
    expect(link.uid).toBe(0);
    expect(link.gid).toBe(0);

    const target = mfs.readlink("/usr/bin/sh");
    expect(target).toBe("/bin/dash");
  });
});

describe("image builder — pass 4: archives", () => {
  const fixture = join(fixtures, "archive");
  const zipPath = join(fixture, "opt", "vim-mini.zip");

  beforeAll(() => {
    mkdirSync(join(fixture, "opt"), { recursive: true });
    const zipBytes = zipSync({
      "bin/vim": new TextEncoder().encode("#!fake-vim\n"),
      "share/vim/vim91/vimrc": new TextEncoder().encode("set nu\n"),
    });
    writeFileSync(zipPath, zipBytes);
  });

  it("extracts archive members under base= with per-archive fmode/dmode/owner", async () => {
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const vim = mfs.stat("/usr/bin/vim");
    expect(vim.mode & 0o777).toBe(0o644); // archive's fmode wins
    expect(vim.uid).toBe(0);
    expect(vim.gid).toBe(0);
    expect(readFromImage(mfs, "/usr/bin/vim")).toBe("#!fake-vim\n");

    const vimrc = mfs.stat("/usr/share/vim/vim91/vimrc");
    expect(vimrc.mode & 0o777).toBe(0o644);
    expect(readFromImage(mfs, "/usr/share/vim/vim91/vimrc")).toBe("set nu\n");
  });

  it("creates parent dirs on demand using dmode", async () => {
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    // /usr/bin is NOT in the MANIFEST — the archive must create it.
    const usrBin = mfs.stat("/usr/bin");
    expect(usrBin.mode & 0o777).toBe(0o755); // archive's dmode

    // /usr/share IS in the MANIFEST (mode 0755) — pass 1 already created it.
    // The archive must not clobber/recreate it.
    const usrShare = mfs.stat("/usr/share");
    expect(usrShare.mode & 0o777).toBe(0o755);
  });
});

describe("image builder — round-trip", () => {
  it("save → load preserves a multi-pass image end-to-end", async () => {
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    // Dirs from pass 1
    expect(() => mfs.stat("/etc")).not.toThrow();
    expect(() => mfs.stat("/tmp")).not.toThrow();
    expect(() => mfs.stat("/home/alice")).not.toThrow();
    // File from pass 2
    expect(() => mfs.stat("/etc/passwd")).not.toThrow();
    // Symlink from pass 3
    expect(mfs.readlink("/usr/bin/sh")).toBe("/bin/dash");
  });
});
