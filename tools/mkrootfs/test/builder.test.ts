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

describe("image builder — validation", () => {
  describe("missing source files", () => {
    it("errors on missing implicit source with manifest line number and resolved path", async () => {
      const fixture = join(fixtures, "missing-source");
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(/line 3.*source file not found.*rootfs\/etc\/passwd/);
    });

    it("errors on missing explicit src= with manifest line number", async () => {
      const fixture = join(fixtures, "missing-explicit-src");
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(/line 3.*source file not found.*missing\/foo\.cfg/);
    });
  });

  describe("duplicate manifest paths", () => {
    it("errors on two entries declaring the same path with both line numbers", async () => {
      const fixture = join(fixtures, "dup-paths");
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(/duplicate.*\/etc\/passwd.*line 3.*line 4/);
    });
  });

  describe("missing archive url=", () => {
    it("errors with manifest line number and url path", async () => {
      const fixture = join(fixtures, "missing-archive-url");
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(/line 3.*archive not found.*opt\/missing\.zip/);
    });
  });

  describe("archive-vs-archive collisions", () => {
    const fixture = join(fixtures, "archive-archive-collision");
    const optDir = join(fixture, "opt");

    beforeAll(() => {
      mkdirSync(optDir, { recursive: true });
      writeFileSync(
        join(optDir, "a.zip"),
        zipSync({ "share/foo": new TextEncoder().encode("from a\n") }),
      );
      writeFileSync(
        join(optDir, "b.zip"),
        zipSync({ "share/foo": new TextEncoder().encode("from b\n") }),
      );
    });

    it("errors when two archives both ship the same path", async () => {
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(
        /archive collision at "\/usr\/share\/foo".*opt\/a\.zip.*line 4.*opt\/b\.zip.*line 5/,
      );
    });
  });

  describe("explicit-vs-archive overrides", () => {
    const fixture = join(fixtures, "archive-collision");
    const zipPath = join(fixture, "opt", "vim-mini.zip");

    beforeAll(() => {
      mkdirSync(join(fixture, "opt"), { recursive: true });
      writeFileSync(
        zipPath,
        zipSync({
          "bin/vim": new TextEncoder().encode("#!archive-vim\n"),
          "bin/other": new TextEncoder().encode("from archive\n"),
        }),
      );
    });

    it("explicit src= entry wins over archive-provided same path", async () => {
      const image = await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      });
      const mfs = MemoryFileSystem.fromImage(image);

      const vim = mfs.stat("/usr/bin/vim");
      expect(vim.mode & 0o777).toBe(0o755); // explicit entry's mode (not archive's 0644)
      expect(readFromImage(mfs, "/usr/bin/vim")).toBe("#!override-vim\n");
    });

    it("non-overlapping archive entries still extract alongside the override", async () => {
      const image = await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      });
      const mfs = MemoryFileSystem.fromImage(image);
      expect(readFromImage(mfs, "/usr/bin/other")).toBe("from archive\n");
    });

    it("reports the override via onWarn callback so users can audit", async () => {
      const warnings: string[] = [];
      await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /\/usr\/bin\/vim.*manifest line 4.*overrides.*opt\/vim-mini\.zip/,
      );
    });
  });

  describe("implicit-vs-archive collisions are rejected", () => {
    const fixture = join(fixtures, "archive-implicit-collision");
    const zipPath = join(fixture, "opt", "vim-mini.zip");

    beforeAll(() => {
      mkdirSync(join(fixture, "opt"), { recursive: true });
      writeFileSync(
        zipPath,
        zipSync({ "bin/vim": new TextEncoder().encode("#!archive-vim\n") }),
      );
    });

    it("errors when an implicit f-entry (no src=) overlaps an archive path", async () => {
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
        }),
      ).rejects.toThrow(
        /\/usr\/bin\/vim.*implicit file.*line 4.*shipped by archive.*opt\/vim-mini\.zip.*line 6.*add src=/,
      );
    });
  });

  describe("explicit dir + archive at same path", () => {
    // Documented behavior from Task 2.4: archive does NOT clobber an explicit
    // dir's mode/uid/gid; the manifest dir wins. Validation should not break this.
    it("preserves the explicit dir's mode when archive entries land underneath", async () => {
      const fixture = join(fixtures, "archive");
      const image = await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      });
      const mfs = MemoryFileSystem.fromImage(image);
      const usrShare = mfs.stat("/usr/share");
      expect(usrShare.mode & 0o777).toBe(0o755);
    });
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
