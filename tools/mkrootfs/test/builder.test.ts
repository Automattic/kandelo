import { describe, it, expect, beforeAll, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { buildImage } from "../src/builder.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_FIXED_SIZE = 46;

function readFromImage(mfs: MemoryFileSystem, path: string): string {
  const fd = mfs.open(path, 0, 0);
  const buf = new Uint8Array(4096);
  const n = mfs.read(fd, buf, null, buf.byteLength);
  mfs.close(fd);
  return new TextDecoder().decode(buf.subarray(0, n));
}

function zipSymlink(
  target: Uint8Array,
): [Uint8Array, { os: number; attrs: number }] {
  return [target, { os: 3, attrs: (0o120777 << 16) >>> 0 }];
}

function zipUnixFile(
  content: string,
  mode: number,
): [Uint8Array, { os: number; attrs: number }] {
  return [
    new TextEncoder().encode(content),
    { os: 3, attrs: ((0o100000 | mode) << 16) >>> 0 },
  ];
}

async function buildArchiveImage(
  entries: Parameters<typeof zipSync>[0],
  archiveFields = "base=/usr fmode=0644 dmode=0755 uid=0 gid=0",
): Promise<Uint8Array> {
  const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-archive-"));
  try {
    writeFileSync(join(tmp, "archive.zip"), zipSync(entries));
    const manifest = join(tmp, "MANIFEST");
    writeFileSync(manifest, `archive url=archive.zip ${archiveFields}\n`);
    return await buildImage({
      sourceTree: tmp,
      manifest,
      repoRoot: tmp,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function corruptFirstCentralDirectoryName(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let offset = 0; offset <= zip.byteLength - 4; offset++) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) continue;
    zip[offset + CENTRAL_DIR_FIXED_SIZE] = 0xff;
    return zip;
  }
  throw new Error("central directory entry not found in test ZIP");
}

describe("image builder reproducibility", () => {
  it("produces identical bytes from identical inputs at different wall times", async () => {
    const fixture = join(fixtures, "basic");
    const now = vi.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_700_000_000_000);
      const first = await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      });

      now.mockReturnValue(1_800_000_000_000);
      const second = await buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      });

      expect(second.byteLength).toBe(first.byteLength);
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
      const restored = MemoryFileSystem.fromImage(first);
      for (const path of ["/", "/etc", "/etc/passwd", "/usr/bin/sh"]) {
        const stat = restored.lstat(path);
        expect(stat.atimeMs, `${path} atime`).toBe(0);
        expect(stat.mtimeMs, `${path} mtime`).toBe(0);
        expect(stat.ctimeMs, `${path} ctime`).toBe(0);
      }
    } finally {
      now.mockRestore();
    }
  });

  it("uses sourceDateEpochSeconds for every inode type", async () => {
    const fixture = join(fixtures, "basic");
    const sourceDateEpochSeconds = 946_684_800;
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
      sourceDateEpochSeconds,
    });
    const restored = MemoryFileSystem.fromImage(image);
    const expectedMs = sourceDateEpochSeconds * 1000;

    for (const path of ["/", "/etc", "/etc/passwd", "/usr/bin/sh"]) {
      const stat = restored.lstat(path);
      expect(stat.atimeMs, `${path} atime`).toBe(expectedMs);
      expect(stat.mtimeMs, `${path} mtime`).toBe(expectedMs);
      expect(stat.ctimeMs, `${path} ctime`).toBe(expectedMs);
    }
  });

  it.each([-1, 1.5, Number.NaN, 9_007_199_254_741])(
    "rejects invalid sourceDateEpochSeconds %s",
    async (sourceDateEpochSeconds) => {
      const fixture = join(fixtures, "basic");
      await expect(
        buildImage({
          sourceTree: join(fixture, "rootfs"),
          manifest: join(fixture, "MANIFEST"),
          repoRoot: fixture,
          sourceDateEpochSeconds,
        }),
      ).rejects.toThrow(/sourceDateEpochSeconds must be an integer/);
    },
  );
});

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

  it("registers lazy file entries without embedding their content", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-lazy-"));
    try {
      const manifest = join(tmp, "MANIFEST");
      writeFileSync(
        manifest,
        [
          "/usr d 0755 0 0",
          "/usr/bin d 0755 0 0",
          "/usr/bin/find f 0755 0 0 lazy_url=binaries/programs/wasm32/findutils/find.wasm lazy_size=12345",
          "",
        ].join("\n"),
      );
      const image = await buildImage({
        sourceTree: tmp,
        manifest,
        repoRoot: tmp,
      });
      const mfs = MemoryFileSystem.fromImage(image);

      const st = mfs.stat("/usr/bin/find");
      expect(st.mode & 0o777).toBe(0o755);
      expect(st.size).toBe(12345);
      expect(mfs.exportLazyEntries()).toEqual([
        {
          ino: st.ino,
          // Root, /usr, /usr/bin, then the untouched lazy stub allocate
          // generations 1 through 4; a fresh lazy stub starts at sequence 1.
          generation: 4,
          dataSequence: 1,
          path: "/usr/bin/find",
          paths: ["/usr/bin/find"],
          url: "binaries/programs/wasm32/findutils/find.wasm",
          size: 12345,
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
      "bin/vi": [
        new TextEncoder().encode("vim"),
        { os: 3, attrs: (0o120777 << 16) >>> 0 },
      ],
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

  it("keeps fixed fmode semantics for Unix executable entries by default", async () => {
    const image = await buildArchiveImage({
      "bin/tool": zipUnixFile("#!/bin/sh\n", 0o755),
    });
    const mfs = MemoryFileSystem.fromImage(image);

    expect(mfs.stat("/usr/bin/tool").mode & 0o777).toBe(0o644);
  });

  it("preserves only trusted Unix executable bits when explicitly requested", async () => {
    const target = new TextEncoder().encode("../../shared/curl");
    const image = await buildArchiveImage(
      {
        "bin/brew": zipUnixFile("#!/usr/bin/env ruby\n", 0o755),
        "Library/Homebrew/shims/shared/curl": zipUnixFile(
          "#!/bin/sh\nexec /usr/bin/curl \"$@\"\n",
          0o4755,
        ),
        "Library/Homebrew/shims/shared/group-tool": zipUnixFile(
          "#!/bin/sh\n",
          0o710,
        ),
        "Library/Homebrew/shims/linux/super/curl": zipSymlink(target),
        "Library/Homebrew/bin/non-executable": new TextEncoder().encode(
          "configuration\n",
        ),
        "Library/Homebrew/readme.txt": zipUnixFile("read me\n", 0o600),
      },
      "base=/home/linuxbrew/.linuxbrew fmode=0644 fmode_policy=preserve-executable dmode=0755 uid=1000 gid=1000",
    );
    const mfs = MemoryFileSystem.fromImage(image);
    const prefix = "/home/linuxbrew/.linuxbrew";

    expect(mfs.stat(`${prefix}/bin/brew`).mode & 0o7777).toBe(0o755);
    expect(
      mfs.stat(`${prefix}/Library/Homebrew/shims/shared/curl`).mode & 0o7777,
    ).toBe(0o755);
    expect(
      mfs.stat(`${prefix}/Library/Homebrew/shims/shared/group-tool`).mode &
        0o7777,
    ).toBe(0o754);

    // set-ID and archive read/write bits are not imported. Non-Unix entries
    // also stay at fmode even when their path triggers ZipEntry's executable
    // compatibility default.
    expect(
      mfs.stat(`${prefix}/Library/Homebrew/bin/non-executable`).mode & 0o7777,
    ).toBe(0o644);
    expect(
      mfs.stat(`${prefix}/Library/Homebrew/readme.txt`).mode & 0o7777,
    ).toBe(0o644);

    const linkPath = `${prefix}/Library/Homebrew/shims/linux/super/curl`;
    expect(mfs.readlink(linkPath)).toBe("../../shared/curl");
    expect(readFromImage(mfs, linkPath)).toContain("exec /usr/bin/curl");
    expect(mfs.stat(linkPath).uid).toBe(1000);
    expect(mfs.stat(linkPath).gid).toBe(1000);
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

  it("preserves Unix symlinks from archive metadata", async () => {
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const vi = mfs.lstat("/usr/bin/vi");
    expect((vi.mode & 0o170000) >>> 0).toBe(0o120000);
    expect(vi.uid).toBe(0);
    expect(vi.gid).toBe(0);
    expect(mfs.readlink("/usr/bin/vi")).toBe("vim");
  });

  it("preserves Homebrew-style parent-relative symlink targets byte-for-byte", async () => {
    const targetBytes = new TextEncoder().encode("../../shared/curl");
    const image = await buildArchiveImage(
      {
        "Library/Homebrew/shims/shared/curl": new TextEncoder().encode(
          "#!/bin/sh\nexec /usr/bin/curl \"$@\"\n",
        ),
        "Library/Homebrew/shims/linux/super/curl": zipSymlink(targetBytes),
      },
      "base=/home/linuxbrew/.linuxbrew fmode=0640 dmode=0750 uid=1000 gid=1000",
    );
    const mfs = MemoryFileSystem.fromImage(image);
    const linkPath =
      "/home/linuxbrew/.linuxbrew/Library/Homebrew/shims/linux/super/curl";

    const link = mfs.lstat(linkPath);
    expect((link.mode & 0o170000) >>> 0).toBe(0o120000);
    expect(link.mode & 0o777).toBe(0o777);
    expect(link.uid).toBe(1000);
    expect(link.gid).toBe(1000);
    expect(mfs.readlink(linkPath)).toBe("../../shared/curl");
    expect(new TextEncoder().encode(mfs.readlink(linkPath))).toEqual(
      targetBytes,
    );

    // Following the relative target reaches the ordinary archive file.
    expect(readFromImage(mfs, linkPath)).toContain("exec /usr/bin/curl");
    const target = mfs.stat(
      "/home/linuxbrew/.linuxbrew/Library/Homebrew/shims/shared/curl",
    );
    expect(target.mode & 0o777).toBe(0o640);
    expect(target.uid).toBe(1000);
    expect(target.gid).toBe(1000);
    const parent = mfs.stat(
      "/home/linuxbrew/.linuxbrew/Library/Homebrew/shims/linux/super",
    );
    expect(parent.mode & 0o777).toBe(0o750);
    expect(parent.uid).toBe(1000);
    expect(parent.gid).toBe(1000);
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

  describe("canonical manifest paths", () => {
    it.each([
      ["repeated slash", "/usr/bin//tool"],
      ["dot component", "/usr/./bin"],
      ["parent component", "/usr/lib/../bin"],
      ["leading double slash", "//usr/bin"],
    ])("rejects a %s before creating a VFS", async (_label, path) => {
      const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-manifest-path-"));
      const create = vi.spyOn(MemoryFileSystem, "create");
      try {
        const manifest = join(tmp, "MANIFEST");
        writeFileSync(manifest, `${path} d 0755 0 0\n`);

        await expect(
          buildImage({ sourceTree: tmp, manifest, repoRoot: tmp }),
        ).rejects.toThrow(/is not a canonical absolute POSIX path/);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects a raw-path duplicate that aliases an earlier manifest path", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-manifest-alias-"));
      try {
        const manifest = join(tmp, "MANIFEST");
        writeFileSync(
          manifest,
          [
            "/usr/bin/tool d 0755 0 0",
            "/usr/bin//tool d 0755 0 0",
            "",
          ].join("\n"),
        );

        await expect(
          buildImage({ sourceTree: tmp, manifest, repoRoot: tmp }),
        ).rejects.toThrow(/manifest path "\/usr\/bin\/\/tool".*not a canonical/);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects an aliased explicit-source override before archive extraction", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-override-alias-"));
      const create = vi.spyOn(MemoryFileSystem, "create");
      try {
        writeFileSync(join(tmp, "override"), "explicit\n");
        writeFileSync(
          join(tmp, "archive.zip"),
          zipSync({ "bin/tool": new TextEncoder().encode("archive\n") }),
        );
        const manifest = join(tmp, "MANIFEST");
        writeFileSync(
          manifest,
          [
            "/usr d 0755 0 0",
            "/usr/bin d 0755 0 0",
            "/usr/bin//tool f 0755 0 0 src=override",
            "archive url=archive.zip base=/usr",
            "",
          ].join("\n"),
        );

        await expect(
          buildImage({ sourceTree: tmp, manifest, repoRoot: tmp }),
        ).rejects.toThrow(/manifest path "\/usr\/bin\/\/tool".*not a canonical/);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("blocks a manifest symlink alias from redirecting an archive write", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-symlink-alias-"));
      const create = vi.spyOn(MemoryFileSystem, "create");
      try {
        writeFileSync(join(tmp, "passwd"), "root:x:0:0:root:/root:/bin/sh\n");
        writeFileSync(
          join(tmp, "archive.zip"),
          zipSync({ "bin/tool": new TextEncoder().encode("overwritten\n") }),
        );
        const manifest = join(tmp, "MANIFEST");
        writeFileSync(
          manifest,
          [
            "/etc d 0755 0 0",
            "/etc/passwd f 0600 42 43 src=passwd",
            "/usr d 0755 0 0",
            "/usr/bin d 0755 0 0",
            "/usr/bin//tool l 0777 1000 1000 target=/etc/passwd",
            "archive url=archive.zip base=/usr fmode=0666 uid=2000 gid=2000",
            "",
          ].join("\n"),
        );

        await expect(
          buildImage({ sourceTree: tmp, manifest, repoRoot: tmp }),
        ).rejects.toThrow(/manifest path "\/usr\/bin\/\/tool".*not a canonical/);
        expect(create).not.toHaveBeenCalled();
        expect(readFileSync(join(tmp, "passwd"), "utf8")).toBe(
          "root:x:0:0:root:/root:/bin/sh\n",
        );
      } finally {
        create.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
      }
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

  describe("archive member paths", () => {
    it.each([
      ["absolute POSIX path", "/etc/passwd", /must be relative, not absolute/],
      [
        "absolute drive path",
        "C:/Windows/system.ini",
        /must be relative, not absolute/,
      ],
      ["backslash separator", "bin\\tool", /contains a backslash/],
      [
        "escaping parent component",
        "../outside",
        /not a canonical relative path/,
      ],
      [
        "embedded parent component",
        "bin/../outside",
        /not a canonical relative path/,
      ],
      ["dot component", "bin/./tool", /not a canonical relative path/],
      ["empty component", "bin//tool", /not a canonical relative path/],
      ["NUL byte", "bin/tool\0hidden", /contains a NUL byte/],
    ])("rejects a %s", async (_label, memberName, expected) => {
      await expect(
        buildArchiveImage({
          [memberName as string]: new TextEncoder().encode("malicious\n"),
        }),
      ).rejects.toThrow(expected as RegExp);
    });

    it.each(["/usr/../etc", "/usr//", "//usr"])(
      "rejects non-canonical archive base %s before mounting members",
      async (base) => {
        await expect(
          buildArchiveImage(
            { "bin/tool": new TextEncoder().encode("tool\n") },
            `base=${base}`,
          ),
        ).rejects.toThrow(
          /archive .* base .* is not a canonical absolute POSIX path/,
        );
      },
    );

    it("rejects invalid central-directory UTF-8 before creating a VFS", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-builder-invalid-name-"));
      const create = vi.spyOn(MemoryFileSystem, "create");
      try {
        writeFileSync(
          join(tmp, "archive.zip"),
          corruptFirstCentralDirectoryName(
            zipSync({ tool: new TextEncoder().encode("content\n") }),
          ),
        );
        const manifest = join(tmp, "MANIFEST");
        writeFileSync(manifest, "archive url=archive.zip base=/usr\n");

        await expect(
          buildImage({ sourceTree: tmp, manifest, repoRoot: tmp }),
        ).rejects.toThrow(/Invalid UTF-8 in ZIP member name/);
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("archive symlink targets", () => {
    it.each([
      ["empty", new Uint8Array(0), /has an empty target/],
      [
        "NUL-containing",
        new Uint8Array([0x2e, 0x2f, 0x00, 0x78]),
        /contains a NUL byte/,
      ],
      ["invalid UTF-8", new Uint8Array([0xc3, 0x28]), /not valid UTF-8/],
    ])("rejects a %s target", async (_label, target, expected) => {
      await expect(
        buildArchiveImage({
          "bin/tool": zipSymlink(target as Uint8Array),
        }),
      ).rejects.toThrow(expected as RegExp);
    });
  });

  describe("archive path types", () => {
    it("rejects a file and directory claiming the same VFS path", async () => {
      await expect(
        buildArchiveImage({
          "share/tool": new TextEncoder().encode("file\n"),
          "share/tool/": new Uint8Array(0),
        }),
      ).rejects.toThrow(/archive type collision at "\/usr\/share\/tool"/);
    });

    it("rejects descendants below an archive symlink", async () => {
      await expect(
        buildArchiveImage({
          "bin/tool": zipSymlink(new TextEncoder().encode("../shared/tool")),
          "bin/tool/plugin": new TextEncoder().encode("must not escape\n"),
        }),
      ).rejects.toThrow(
        /archive member "\/usr\/bin\/tool\/plugin".*descends through archive symlink "\/usr\/bin\/tool"/,
      );
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

  it("can stamp image-level kernel ABI metadata", async () => {
    const fixture = join(fixtures, "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
      metadata: {
        version: 1,
        kernelAbi: 11,
        createdBy: "builder.test",
      },
    });

    expect(MemoryFileSystem.readImageMetadata(image)).toEqual({
      version: 1,
      kernelAbi: 11,
      createdBy: "builder.test",
    });
    expect(MemoryFileSystem.fromImage(image).getImageMetadata()).toEqual({
      version: 1,
      kernelAbi: 11,
      createdBy: "builder.test",
    });
  });
});
