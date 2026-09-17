import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { zipSync } from "fflate";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { parseManifest } from "../src/manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const shim = join(here, "..", "bin", "mkrootfs.mjs");

/**
 * Read an image the CLI wrote, through the reader the CLI itself uses.
 *
 * This was `MemoryFileSystem.fromImage`, a second reader — and one that could
 * not see a deferred file's description at all, which is the defect the verbs
 * were repointed to end. A test oracle blind to half the artifact certifies
 * the half it can see.
 */
function readBack(image: Uint8Array): KandeloImageFs {
  const fs = KandeloImageFs.create();
  fs.loadImage(image);
  return fs;
}

function run(...args: string[]) {
  return spawnSync(shim, args, { encoding: "utf8", cwd: repoRoot });
}

function runWithSourceDateEpoch(sourceDateEpoch: string, ...args: string[]) {
  return spawnSync(shim, args, {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
  });
}

/**
 * Where the tampered descriptor lives in the image, asserted to be the only
 * copy. A tamper applied to the wrong bytes -- or to one of two copies --
 * reads exactly like a guard that refused, so the test would pass while
 * proving nothing about seals.
 */
function onlyOffsetOf(image: Uint8Array, needle: Uint8Array): number {
  const found: number[] = [];
  outer: for (let i = 0; i + needle.length <= image.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (image[i + j] !== needle[j]) continue outer;
    }
    found.push(i);
  }
  expect(found).toHaveLength(1);
  return found[0];
}

describe("mkrootfs imported atomic seal boundary", () => {
  it("refuses a tampered cohort seal before inspect prints, extract writes, or add saves", () => {
    // WHAT THIS DEFENDS. All three verbs load an image the caller handed them
    // and then act on it -- print it, write it to disk, save a mutated copy
    // back over it. An image whose activation cohort does not authenticate has
    // been altered since it was sealed, and acting on it would launder the
    // alteration through a tool the caller trusts. `add` is the worst of the
    // three, because its output REPLACES the input.
    //
    // HOW THE REFUSAL ARRIVES, which is the part this rewrite changes. It used
    // to be `verifyImportedLazyAtomicGroupSeals`, a separate call each verb
    // made against a second reader; now `loadImage` refuses, because
    // `rootfs::load_image` authenticates every cohort seal in the container it
    // is handed. So the claim tested here is no longer "each verb remembers to
    // check" but "no verb can forget" -- there is no longer a call to omit.
    //
    // THE TAMPER IS THE DESCRIPTOR, not the digest. The seal covers the
    // archive's fetch descriptor, so altering the descriptor's bytes leaves
    // every digest in the image intact and self-consistent while making the
    // sealed claim false -- the shape of a real tamper, and the one a
    // structural validator cannot see. The module's own tests cover the other
    // failing shapes (a cohort short of its count, members that disagree, a
    // seal left pending); this file is about the CLI boundary, so it needs one
    // refusal that certainly reaches it.
    const encoder = new TextEncoder();
    const build = () => {
      const fs = KandeloImageFs.create();
      fs.mkdir("/opt", 0o755);
      for (const [archiveId, name] of [[3, "tools"], [4, "docs"]] as const) {
        fs.registerArchiveMember({
          path: `/opt/${name}`,
          archiveId,
          sourcePath: `members/${name}`,
          size: 10,
          mode: 0o644,
          ino: 40 + archiveId,
          archiveBytes: 8_000_000,
          archiveDescriptor: encoder.encode(
            `{"url":"https://example.invalid/${name}.zip"}`,
          ),
          cohort: { id: "shell", member: name, expectedCount: 2 },
        });
      }
      return fs.exportImage();
    };

    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-tampered-seal-"));
    try {
      const tampered = build();
      const host = encoder.encode("https://example.invalid/tools.zip");
      // One byte, inside the sealed descriptor, in a field no reader parses.
      tampered[onlyOffsetOf(tampered, host) + "https://example.".length] = 0x78;

      const image = join(tmp, "tampered.vfs");
      writeFileSync(image, tampered);
      const original = readFileSync(image);

      const inspect = run("inspect", image);
      expect(inspect.status).not.toBe(0);
      expect(inspect.stdout).toBe("");
      expect(inspect.stderr).toMatch(/EPERM/);

      const out = join(tmp, "out");
      const extract = run("extract", image, out);
      expect(extract.status).not.toBe(0);
      expect(extract.stderr).toMatch(/EPERM/);
      expect(existsSync(out)).toBe(false);

      const add = run(
        "add", image, "/etc/new", "--file", join(tmp, "missing-source"),
      );
      expect(add.status).not.toBe(0);
      expect(add.stderr).toMatch(/EPERM/);
      expect(readFileSync(image).equals(original)).toBe(true);

      // THE NEGATIVE CONTROL, and it is what makes the three refusals above
      // about the SEAL. The same builder, the same cohort, the same archive
      // members -- untampered -- must be read and printed. Without it, a verb
      // that refused every image carrying an archive would look identical.
      const intact = join(tmp, "intact.vfs");
      writeFileSync(intact, build());
      const good = run("inspect", intact);
      expect(good.stderr).toBe("");
      expect(good.status).toBe(0);
      expect(good.stdout).toContain("/opt/tools");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("mkrootfs CLI — top-level", () => {
  it("prints usage on --help and exits 0", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: mkrootfs");
    expect(r.stdout).toContain("build");
  });

  it("exits non-zero on unknown subcommand and writes usage", () => {
    const r = run("bogus");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`unknown command "bogus"`);
  });

  it("all four subcommands are wired (no more 'not yet implemented' stubs)", () => {
    for (const sub of ["build", "inspect", "extract", "add"]) {
      const r = run(sub, "--help");
      expect(r.status, `${sub} --help should exit 0`).toBe(0);
      expect(r.stdout).toContain(sub);
      expect(r.stderr).not.toContain("not yet implemented");
    }
  });
});

describe("mkrootfs build — happy paths", () => {
  it("builds byte-identical images across separate invocations", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-reproducible-"));
    const first = join(tmp, "first.vfs");
    const second = join(tmp, "second.vfs");
    try {
      for (const output of [first, second]) {
        const result = run(
          "build",
          join(fixture, "MANIFEST"),
          join(fixture, "rootfs"),
          "-o", output,
          "--repo-root", fixture,
        );
        expect(result.status).toBe(0);
      }
      expect(readFileSync(second).equals(readFileSync(first))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("honors SOURCE_DATE_EPOCH for directories, files, and symlinks", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-epoch-"));
    const out = join(tmp, "rootfs.vfs");
    try {
      const result = runWithSourceDateEpoch(
        "946684800",
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
      );
      expect(result.status).toBe(0);

      // ASSERTED THROUGH THE BYTES, not through a reader's stat.
      //
      // This read each inode's three stamps back with `MemoryFileSystem`,
      // whose `lstat` reports times; the module's does not, because a builder
      // has no use for them. What the flag is FOR is reproducibility, and that
      // is checkable without any reader at all: the same epoch must produce
      // the same image, and a different epoch must produce a different one.
      // The second half is what makes the first half mean something — two
      // builds that ignored the epoch entirely would also match.
      const sameEpoch = join(tmp, "same-epoch.vfs");
      const otherEpoch = join(tmp, "other-epoch.vfs");
      expect(runWithSourceDateEpoch(
        "946684800",
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", sameEpoch,
        "--repo-root", fixture,
      ).status).toBe(0);
      expect(runWithSourceDateEpoch(
        "1700000000",
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", otherEpoch,
        "--repo-root", fixture,
      ).status).toBe(0);

      expect(readFileSync(sameEpoch).equals(readFileSync(out))).toBe(true);
      expect(readFileSync(otherEpoch).equals(readFileSync(out))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds an image from MANIFEST + sourceTree and writes it to -o", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "rootfs.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
      );
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);

      const bytes = new Uint8Array(readFileSync(out));
      const mfs = readBack(bytes);
      // pass-1 dir, pass-2 file, pass-3 symlink all present.
      expect(() => mfs.stat("/etc")).not.toThrow();
      expect(() => mfs.stat("/etc/passwd")).not.toThrow();
      expect(mfs.readlink("/usr/bin/sh")).toBe("/bin/dash");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("build + inspect preserves opted-in vendor executables and symlinks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-archive-link-"));
    const image = join(tmp, "pkg.vfs");
    const target = "../../shared/curl";
    try {
      writeFileSync(
        join(tmp, "pkg.zip"),
        zipSync({
          "bin/pkgtool": [
            new TextEncoder().encode("#!/usr/bin/env ruby\n"),
            { os: 3, attrs: (0o100755 << 16) >>> 0 },
          ],
          "Library/vendor/shims/shared/curl": [
            new TextEncoder().encode("curl shim\n"),
            { os: 3, attrs: (0o100755 << 16) >>> 0 },
          ],
          "Library/vendor/shims/linux/super/curl": [
            new TextEncoder().encode(target),
            { os: 3, attrs: (0o120777 << 16) >>> 0 },
          ],
          "Library/vendor/bin/non-executable": new TextEncoder().encode(
            "configuration\n",
          ),
        }),
      );
      writeFileSync(
        join(tmp, "MANIFEST"),
        "archive url=pkg.zip base=/opt/kandelo/pkg fmode=0644 fmode_policy=preserve-executable uid=1000 gid=1000\n",
      );

      const build = run(
        "build",
        join(tmp, "MANIFEST"),
        tmp,
        "-o", image,
        "--repo-root", tmp,
      );
      expect(build.status).toBe(0);

      const inspect = run("inspect", image, "--format", "json");
      expect(inspect.status).toBe(0);
      const entries = JSON.parse(inspect.stdout) as Array<{
        path: string;
        type: string;
        mode: string;
        uid: number;
        gid: number;
        target?: string;
      }>;
      const link = entries.find(
        (entry) => entry.path ===
          "/opt/kandelo/pkg/Library/vendor/shims/linux/super/curl",
      );
      expect(link).toEqual({
        path: "/opt/kandelo/pkg/Library/vendor/shims/linux/super/curl",
        type: "l",
        mode: "0777",
        uid: 1000,
        gid: 1000,
        size: null,
        target,
      });

      expect(entries.find((entry) => entry.path ===
        "/opt/kandelo/pkg/bin/pkgtool")).toMatchObject({
        type: "f",
        mode: "0755",
        uid: 1000,
        gid: 1000,
      });
      expect(entries.find((entry) => entry.path ===
        "/opt/kandelo/pkg/Library/vendor/shims/shared/curl")).toMatchObject({
        type: "f",
        mode: "0755",
        uid: 1000,
        gid: 1000,
      });
      expect(entries.find((entry) => entry.path ===
        "/opt/kandelo/pkg/Library/vendor/bin/non-executable")).toMatchObject({
        type: "f",
        mode: "0644",
        uid: 1000,
        gid: 1000,
      });

      const mfs = readBack(new Uint8Array(readFileSync(image)));
      expect(mfs.readlink(link!.path)).toBe(target);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts --output as a long-form alias for -o, and --repo-root=<dir>", () => {
    const fixture = join(here, "fixtures", "explicit-src");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "--output", out,
        `--repo-root=${fixture}`,
      );
      expect(r.status).toBe(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts repeated --manifest-fragment entries after the main MANIFEST", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const sourceTree = join(tmp, "rootfs");
    const out = join(tmp, "image.vfs");
    try {
      mkdirSync(join(sourceTree, "etc"), { recursive: true });
      writeFileSync(join(sourceTree, "etc", "passwd"), "root:x:0:0:root:/root:/bin/sh\n");
      writeFileSync(
        join(tmp, "MANIFEST"),
        [
          "/etc d 0755 0 0",
          "/etc/passwd f 0644 0 0",
          "/usr d 0755 0 0",
          "/usr/bin d 0755 0 0",
          "",
        ].join("\n"),
      );
      writeFileSync(join(tmp, "env-bin"), "#!/bin/sh\n");
      writeFileSync(join(tmp, "printf-bin"), "#!/bin/sh\n");
      writeFileSync(
        join(tmp, "coreutils.MANIFEST"),
        [
          "/usr/bin/env f 0755 0 0 src=env-bin",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(tmp, "more-utils.MANIFEST"),
        [
          "/usr/bin/printf f 0755 0 0 src=printf-bin",
          "",
        ].join("\n"),
      );

      const r = run(
        "build",
        join(tmp, "MANIFEST"),
        sourceTree,
        "-o", out,
        "--repo-root", tmp,
        "--manifest-fragment", join(tmp, "coreutils.MANIFEST"),
        `--manifest-fragment=${join(tmp, "more-utils.MANIFEST")}`,
      );
      expect(r.status).toBe(0);

      const bytes = new Uint8Array(readFileSync(out));
      const mfs = readBack(bytes);
      expect(mfs.stat("/usr/bin/env").mode & 0o777).toBe(0o755);
      expect(mfs.stat("/usr/bin/printf").mode & 0o777).toBe(0o755);
      const fd = mfs.open("/usr/bin/env", 0, 0);
      try {
        const buf = new Uint8Array(16);
        const n = mfs.read(fd, buf, null, buf.byteLength);
        expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("#!/bin/sh\n");
      } finally {
        mfs.close(fd);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts --sab-size to control the image backing store size", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "small.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
        "--sab-size", "1048576",
      );
      expect(r.status).toBe(0);
      expect(readFileSync(out).byteLength).toBeLessThan(2 * 1024 * 1024);
      expect(() => readBack(new Uint8Array(readFileSync(out)))).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts --max-size to control image growth capacity", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "growable.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
        "--sab-size", "1048576",
        "--max-size", "8388608",
      );
      expect(r.status).toBe(0);

      const mfs = readBack(new Uint8Array(readFileSync(out)));
      const fd = mfs.open("/large.bin", 0x0001 | 0x0040 | 0x0200, 0o644);
      try {
        const data = new Uint8Array(5 * 1024 * 1024);
        expect(mfs.write(fd, data, null, data.length)).toBe(data.length);
      } finally {
        mfs.close(fd);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints onWarn messages to stderr by default", () => {
    const fixture = join(here, "fixtures", "archive-collision");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
      );
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("warning:");
      expect(r.stderr).toContain("/usr/bin/vim");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--quiet suppresses onWarn messages", () => {
    const fixture = join(here, "fixtures", "archive-collision");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
        "--quiet",
      );
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("warning:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--kernel-abi stamps image metadata", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
        // THE CURRENT ABI, because reading metadata back means LOADING the
        // image, and the loader refuses one that declares an ABI it does not
        // speak. That refusal is the contract (see the stale-image case
        // above); its cost is that nobody can ask a stale artifact which ABI
        // it claims. What this case is about — the flag's value reaching the
        // image's metadata — is unchanged by using a value the reader speaks.
        "--kernel-abi", String(ABI_VERSION),
      );
      expect(r.status).toBe(0);
      const metadata = KandeloImageFs.readImageMetadata(new Uint8Array(readFileSync(out)));
      expect(metadata).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        createdBy: "mkrootfs build",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("binds a staged image to the exact ABI snapshot digest", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    const snapshotSha256 = "a".repeat(64);
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
        "--kernel-abi", String(ABI_VERSION),
        "--abi-snapshot-sha256", snapshotSha256,
      );
      expect(r.status).toBe(0);
      const metadata = KandeloImageFs.readImageMetadata(
        new Uint8Array(readFileSync(out)),
      );
      expect(metadata).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        abiSnapshotSha256: snapshotSha256,
        createdBy: "mkrootfs build",
      });

      const missingAbi = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "missing-abi.vfs"),
        "--repo-root", fixture,
        "--abi-snapshot-sha256", snapshotSha256,
      );
      expect(missingAbi.status).toBe(2);
      expect(missingAbi.stderr).toContain(
        "--abi-snapshot-sha256 requires --kernel-abi",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints subcommand usage on `build --help` and exits 0 without writing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "should-not-exist.vfs");
    try {
      const r = run("build", "--help");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("build");
      expect(r.stdout).toContain("MANIFEST");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("mkrootfs build — error handling", () => {
  it("rejects an invalid archive fmode policy before writing an image", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-mode-policy-"));
    const output = join(tmp, "rootfs.vfs");
    try {
      writeFileSync(
        join(tmp, "MANIFEST"),
        "archive url=missing.zip fmode_policy=inherit-all\n",
      );
      const result = run(
        "build",
        join(tmp, "MANIFEST"),
        tmp,
        "-o", output,
        "--repo-root", tmp,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'invalid fmode_policy "inherit-all" (expected fixed or preserve-executable)',
      );
      expect(result.stderr).not.toContain("archive not found");
      expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects an invalid SOURCE_DATE_EPOCH", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-epoch-"));
    try {
      const result = runWithSourceDateEpoch(
        "1.5",
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "rootfs.vfs"),
        "--repo-root", fixture,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "SOURCE_DATE_EPOCH must be a non-negative integer",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits non-zero when -o is missing", () => {
    const fixture = join(here, "fixtures", "basic");
    const r = run(
      "build",
      join(fixture, "MANIFEST"),
      join(fixture, "rootfs"),
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/usage|missing|-o/i);
  });

  it("exits non-zero on too few positional args", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    try {
      const r = run("build", join(fixture, "MANIFEST"), "-o", join(tmp, "x.vfs"));
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/usage|positional/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits non-zero on unknown flags", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "x.vfs"),
        "--bogus",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("--bogus");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits non-zero when --manifest-fragment is missing its value", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "x.vfs"),
        "--manifest-fragment",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("requires a value");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits non-zero when --sab-size is not a positive integer", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "x.vfs"),
        "--sab-size=0",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("--sab-size must be a positive integer");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports duplicate paths across MANIFEST and manifest fragments", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const sourceTree = join(tmp, "rootfs");
    try {
      mkdirSync(join(sourceTree, "etc"), { recursive: true });
      writeFileSync(join(tmp, "MANIFEST"), "/etc d 0755 0 0\n");
      writeFileSync(join(tmp, "fragment.MANIFEST"), "/etc d 0755 0 0\n");

      const r = run(
        "build",
        join(tmp, "MANIFEST"),
        sourceTree,
        "-o", join(tmp, "image.vfs"),
        "--manifest-fragment", join(tmp, "fragment.MANIFEST"),
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("duplicate manifest path");
      expect(r.stderr).toContain("/etc");
      expect(existsSync(join(tmp, "image.vfs"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits non-zero on invalid --kernel-abi", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", join(tmp, "x.vfs"),
        "--kernel-abi", "abc",
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("--kernel-abi");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports a clean error (no stack trace) when MANIFEST is missing", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(tmp, "does-not-exist.MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mkrootfs build:");
      expect(r.stderr).not.toContain("at ");
      expect(r.stderr).not.toMatch(/\.ts:\d+/);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports a clean error (no stack trace) when an explicit src= is missing", () => {
    const fixture = join(here, "fixtures", "missing-explicit-src");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-build-"));
    const out = join(tmp, "image.vfs");
    try {
      const r = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", out,
        "--repo-root", fixture,
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("source file not found");
      expect(r.stderr).not.toContain("at ");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function buildBasicImage(): { tmp: string; image: string } {
  const fixture = join(here, "fixtures", "basic");
  const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-"));
  const image = join(tmp, "rootfs.vfs");
  const r = run(
    "build",
    join(fixture, "MANIFEST"),
    join(fixture, "rootfs"),
    "-o", image,
    "--repo-root", fixture,
  );
  if (r.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`build prerequisite failed: ${r.stderr}`);
  }
  return { tmp, image };
}

describe("mkrootfs inspect — happy paths", () => {
  it("table format lists every entry sorted by path with type/mode/uid/gid/size", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("inspect", image);
      expect(r.status).toBe(0);
      const lines = r.stdout.trimEnd().split("\n");
      // Header + 8 entries (/, /etc, /etc/passwd, /home, /home/alice,
      // /tmp, /usr, /usr/bin, /usr/bin/sh).
      expect(lines[0]).toMatch(/^type\s+mode\s+uid\s+gid\s+size\s+path/);
      const paths = lines.slice(1).map((l) => l.split(/\s+/).at(-1));
      const idx = (p: string) => paths.findIndex((s) => s === p || s?.startsWith(`${p} `));
      // Sorted: / < /etc < /etc/passwd < /home < ...
      expect(idx("/")).toBe(0);
      expect(idx("/etc")).toBeLessThan(idx("/etc/passwd"));
      expect(idx("/etc/passwd")).toBeLessThan(idx("/home"));
      // File row reports honest size (passwd is 137 bytes).
      const passwd = lines.find((l) => l.includes(" /etc/passwd"));
      expect(passwd).toBeTruthy();
      expect(passwd).toMatch(/\bf\s+0644\s+0\s+0\s+137\s+\/etc\/passwd/);
      // Symlink row shows " -> target".
      const sh = lines.find((l) => l.includes("/usr/bin/sh"));
      expect(sh).toBeTruthy();
      expect(sh).toMatch(/\bl\s+0777\b/);
      expect(sh).toContain("/usr/bin/sh -> /bin/dash");
      // Sticky-bit dir.
      const tmpRow = lines.find((l) => / \/tmp$/.test(l));
      expect(tmpRow).toMatch(/\bd\s+1777\s+0\s+0\s+-/);
      // Non-zero uid/gid preserved.
      const alice = lines.find((l) => l.includes("/home/alice"));
      expect(alice).toMatch(/\bd\s+0700\s+1000\s+1000\s+-/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("json format emits a parseable sorted array of entries", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("inspect", image, "--format", "json");
      expect(r.status).toBe(0);
      const data = JSON.parse(r.stdout) as Array<{
        path: string;
        type: string;
        mode: string;
        uid: number;
        gid: number;
        size: number | null;
        target?: string;
      }>;
      expect(Array.isArray(data)).toBe(true);
      // Sorted by path.
      const paths = data.map((e) => e.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
      // Root is first.
      expect(data[0].path).toBe("/");
      expect(data[0].type).toBe("d");
      // Symlink carries target and null size.
      const sh = data.find((e) => e.path === "/usr/bin/sh");
      expect(sh).toBeDefined();
      expect(sh!.type).toBe("l");
      expect(sh!.target).toBe("/bin/dash");
      // Regular file carries honest size.
      const passwd = data.find((e) => e.path === "/etc/passwd");
      expect(passwd!.type).toBe("f");
      expect(passwd!.size).toBe(137);
      expect(passwd!.mode).toBe("0644");
      // Dir size is null (not included as a number).
      const etc = data.find((e) => e.path === "/etc");
      expect(etc!.size).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drains JSON output larger than the process stdout buffer", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-large-"));
    const image = join(tmp, "large.vfs");
    try {
      const mfs = KandeloImageFs.create();
      for (let i = 0; i < 1_500; i++) {
        const name = `/entry-${String(i).padStart(4, "0")}-with-a-long-name`;
        mfs.createFileWithOwner(name, 0o644, 0, 0, new Uint8Array(0));
      }
      writeFileSync(image, await mfs.saveImage());

      const r = run("inspect", image, "--format", "json");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(64 * 1024);
      const data = JSON.parse(r.stdout) as Array<{ path: string }>;
      expect(data).toHaveLength(1_501);
      expect(data.at(-1)?.path).toBe("/entry-1499-with-a-long-name");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits cleanly when a pipe consumer closes stdout early", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-epipe-"));
    const image = join(tmp, "large.vfs");
    try {
      const mfs = KandeloImageFs.create();
      for (let i = 0; i < 1_500; i++) {
        const name = `/entry-${String(i).padStart(4, "0")}-with-a-long-name`;
        mfs.createFileWithOwner(name, 0o644, 0, 0, new Uint8Array(0));
      }
      writeFileSync(image, await mfs.saveImage());

      const child = spawn(shim, ["inspect", image, "--format", "json"], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );

      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => {
          child.stdout.destroy();
          resolve();
        });
        child.stdout.once("error", reject);
      });

      await expect(result).resolves.toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--metadata includes image metadata in json output", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-"));
    const image = join(tmp, "rootfs.vfs");
    try {
      const build = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", image,
        "--repo-root", fixture,
        // THE CURRENT ABI, NOT A LITERAL, and the change is not cosmetic. This
        // built an ABI-11 image and inspected it, which worked while the verb
        // read with a parser that had no opinion about ABI. It reads with the
        // kernel's loader now, and that loader refuses an image declaring an
        // ABI it does not speak -- so an arbitrary number here would be
        // testing the refusal, not the metadata round-trip this case is about.
        // The stale-image refusal has its own case below.
        `--kernel-abi=${ABI_VERSION}`,
      );
      expect(build.status).toBe(0);

      const r = run("inspect", image, "--format", "json", "--metadata");
      expect(r.status).toBe(0);
      const data = JSON.parse(r.stdout) as {
        metadata: { version: 1; kernelAbi: number; createdBy: string };
        entries: Array<{ path: string }>;
      };
      expect(data.metadata).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        createdBy: "mkrootfs build",
      });
      expect(data.entries.some((e) => e.path === "/etc/passwd")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--metadata includes image metadata before table output", () => {
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-"));
    const image = join(tmp, "rootfs.vfs");
    try {
      const build = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", image,
        "--repo-root", fixture,
        `--kernel-abi=${ABI_VERSION}`,
      );
      expect(build.status).toBe(0);

      const r = run("inspect", image, "--metadata");
      expect(r.status).toBe(0);
      const first = r.stdout.split("\n")[0];
      expect(first).toContain("metadata");
      expect(first).toContain(`"kernelAbi":${ABI_VERSION}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tells a caller to rebuild an image built for another kernel ABI", () => {
    // THE CAPABILITY THIS BOUNDARY COSTS, stated where it is paid. Reading
    // with the kernel's loader means these verbs can no longer look inside an
    // image built for a different ABI -- and looking inside a stale image is
    // exactly when someone reaches for `inspect`.
    //
    // It is still the right trade. Two readers disagreeing about one image is
    // the defect the repoint exists to end, and an image that the kernel will
    // refuse to boot is not something a build tool should quietly describe as
    // fine. But a refusal has to say WHICH refusal it is: the image is intact,
    // it is stale, and the fix is a rebuild rather than a hunt for corruption.
    // All three verbs load through the same door, so all three must say so.
    const fixture = join(here, "fixtures", "basic");
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-stale-abi-"));
    const image = join(tmp, "rootfs.vfs");
    try {
      const build = run(
        "build",
        join(fixture, "MANIFEST"),
        join(fixture, "rootfs"),
        "-o", image,
        "--repo-root", fixture,
        "--kernel-abi=11",
      );
      expect(build.status).toBe(0);

      for (const argv of [
        ["inspect", image],
        ["extract", image, join(tmp, "out")],
        ["add", image, "/etc/new", "--dir"],
      ]) {
        const r = run(...argv);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("built for a different kernel ABI");
        expect(r.stderr).toContain("Rebuild it");
        // NOT the corruption wording, which is the half that would rot first:
        // a future edit could add the ABI sentence beside the old message and
        // leave the misleading half in place.
        expect(r.stderr).not.toContain("not a valid VFS image");
      }
      expect(existsSync(join(tmp, "out"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--format=json long-form works and matches --format json output", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const a = run("inspect", image, "--format=json");
      const b = run("inspect", image, "--format", "json");
      expect(a.status).toBe(0);
      expect(b.status).toBe(0);
      expect(a.stdout).toBe(b.stdout);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints subcommand usage on `inspect --help` and exits 0", () => {
    const r = run("inspect", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("inspect");
    expect(r.stdout).toContain("--format");
  });
});

describe("mkrootfs inspect — error handling", () => {
  it("exits 1 with a clean error when the image file does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-"));
    try {
      const r = run("inspect", join(tmp, "nope.vfs"));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("image not found");
      expect(r.stderr).not.toContain("at ");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 with a clean error when the file is not a valid VFS image", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-inspect-"));
    const garbage = join(tmp, "garbage.vfs");
    try {
      writeFileSync(garbage, "this is not a vfs image\n");
      const r = run("inspect", garbage);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mkrootfs inspect:");
      expect(r.stderr).not.toContain("at ");
      expect(r.stderr).not.toMatch(/\.ts:\d+/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 on missing positional argument", () => {
    const r = run("inspect");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/positional|usage/i);
  });

  it("exits 2 on unknown flag", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("inspect", image, "--bogus");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--bogus");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 when --format value is not table|json", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("inspect", image, "--format", "yaml");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--format");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

interface WalkedEntry {
  rel: string;
  type: "d" | "f" | "l";
  mode: number;
  size?: number;
  target?: string;
  content?: Buffer;
}

function walkHostTree(root: string): WalkedEntry[] {
  const out: WalkedEntry[] = [];
  function visit(rel: string): void {
    const abs = rel === "" ? root : join(root, rel);
    const st = lstatSync(abs);
    const mode = st.mode & 0o7777;
    if (st.isDirectory()) {
      out.push({ rel: rel === "" ? "/" : `/${rel}`, type: "d", mode });
      const names = readdirSync(abs).sort();
      for (const n of names) {
        const childRel = rel === "" ? n : `${rel}/${n}`;
        visit(childRel);
      }
    } else if (st.isSymbolicLink()) {
      out.push({
        rel: `/${rel}`,
        type: "l",
        mode,
        target: readlinkSync(abs),
      });
    } else if (st.isFile()) {
      out.push({
        rel: `/${rel}`,
        type: "f",
        mode,
        size: st.size,
        content: readFileSync(abs),
      });
    }
  }
  visit("");
  return out;
}

describe("mkrootfs extract — happy paths", () => {
  it("round-trips a built image: extract → walk host tree matches image", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const outDir = join(tmp, "extracted");
      const r = run("extract", image, outDir);
      expect(r.status).toBe(0);

      const walked = walkHostTree(outDir);
      const byPath = new Map(walked.map((e) => [e.rel, e]));

      // Every directory from the manifest should have been created.
      expect(byPath.get("/")?.type).toBe("d");
      expect(byPath.get("/etc")?.type).toBe("d");
      expect(byPath.get("/etc/passwd")?.type).toBe("f");
      expect(byPath.get("/usr/bin/sh")?.type).toBe("l");

      // File content matches source byte-for-byte.
      const passwdSrc = readFileSync(
        join(here, "fixtures", "basic", "rootfs", "etc", "passwd"),
      );
      expect(byPath.get("/etc/passwd")!.content!.equals(passwdSrc)).toBe(true);

      // Symlink target preserved (extracted symlink points at /bin/dash, which
      // is dangling on the host fs; that's fine, the link itself is what we
      // care about).
      expect(byPath.get("/usr/bin/sh")!.target).toBe("/bin/dash");

      // Mode bits preserved on dirs and files. Sticky bit (1777) must survive.
      expect(byPath.get("/tmp")!.mode).toBe(0o1777);
      expect(byPath.get("/home/alice")!.mode).toBe(0o700);
      expect(byPath.get("/etc/passwd")!.mode).toBe(0o644);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--manifest emits a sidecar that re-parses cleanly via parseManifest", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const outDir = join(tmp, "extracted");
      const r = run("extract", image, outDir, "--manifest");
      expect(r.status).toBe(0);
      const manifestPath = join(outDir, "MANIFEST");
      expect(existsSync(manifestPath)).toBe(true);

      const text = readFileSync(manifestPath, "utf8");
      const entries = parseManifest(text, manifestPath);
      const byPath = new Map(entries.map((e) => [
        e.kind === "node" ? e.path : `archive:${e.url}`,
        e,
      ]));

      // /home/alice was uid=1000 gid=1000 in the source manifest — that has to
      // round-trip via the sidecar (host fs can't preserve the chown).
      const alice = byPath.get("/home/alice");
      expect(alice).toBeDefined();
      expect(alice!.kind).toBe("node");
      if (alice!.kind === "node") {
        expect(alice!.type).toBe("d");
        expect(alice!.uid).toBe(1000);
        expect(alice!.gid).toBe(1000);
        expect(alice!.mode).toBe(0o700);
      }

      // Symlink reproduces target=.
      const sh = byPath.get("/usr/bin/sh");
      expect(sh).toBeDefined();
      if (sh && sh.kind === "node") {
        expect(sh.type).toBe("l");
        expect(sh.target).toBe("/bin/dash");
      }

      // Sticky-bit dir round-trips its mode.
      const tmpDir = byPath.get("/tmp");
      if (tmpDir && tmpDir.kind === "node") {
        expect(tmpDir.mode).toBe(0o1777);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--force allows extracting into a pre-existing empty out-dir", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const outDir = join(tmp, "extracted");
      // Pre-create the out-dir so extract's existsSync check sees it.
      mkdtempSync(outDir + "-"); // sibling, just to keep tmp non-empty
      // Without --force, extract sees an existing tmp tree and refuses.
      const rNo = run("extract", image, tmp);
      expect(rNo.status).toBe(1);
      expect(rNo.stderr).toContain("already exists");
      // With --force into a fresh empty dir, extract overlays cleanly.
      // (mkdirSync recursive is a no-op when the dir already exists, so
      //  /etc/passwd etc. lay down on top of the empty out-dir.)
      const empty = mkdtempSync(join(tmp, "empty-"));
      const r3 = run("extract", image, empty, "--force");
      expect(r3.status).toBe(0);
      expect(existsSync(join(empty, "etc", "passwd"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints subcommand usage on `extract --help` and exits 0", () => {
    const r = run("extract", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("extract");
    expect(r.stdout).toContain("--manifest");
    expect(r.stdout).toContain("--force");
  });
});

describe("mkrootfs extract — error handling", () => {
  it("exits 1 with a clean error when the image file does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-extract-"));
    try {
      const r = run("extract", join(tmp, "nope.vfs"), join(tmp, "out"));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("image not found");
      expect(r.stderr).not.toContain("at ");
      expect(existsSync(join(tmp, "out"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 with a clean error when the file is not a valid VFS image", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-extract-"));
    const garbage = join(tmp, "garbage.vfs");
    try {
      writeFileSync(garbage, "this is not a vfs image\n");
      const r = run("extract", garbage, join(tmp, "out"));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mkrootfs extract:");
      expect(r.stderr).not.toContain("at ");
      expect(r.stderr).not.toMatch(/\.ts:\d+/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 when out-dir already exists without --force", () => {
    const { tmp, image } = buildBasicImage();
    try {
      // Pre-create the dir so extract sees it.
      writeFileSync(join(tmp, "sentinel"), "x");
      // Use the tmp dir itself (already exists). Verify error.
      const r = run("extract", image, tmp);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("already exists");
      expect(r.stderr).toContain("--force");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 on missing positional arguments", () => {
    const r = run("extract");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/positional|usage/i);
  });

  it("exits 2 on unknown flag", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("extract", image, join(tmp, "out"), "--bogus");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--bogus");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function inspectJson(image: string): Array<{
  path: string;
  type: string;
  mode: string;
  uid: number;
  gid: number;
  size: number | null;
  target?: string;
}> {
  const r = run("inspect", image, "--format", "json");
  if (r.status !== 0) {
    throw new Error(`inspect failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

describe("mkrootfs add — happy paths", () => {
  it("adds a regular file with content + metadata, in place", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const src = join(tmp, "hello.txt");
      writeFileSync(src, "hello, world\n");
      const r = run(
        "add", image, "/etc/hello",
        "--file", src,
        "--mode", "0640",
        "--uid", "5",
        "--gid", "7",
      );
      expect(r.status).toBe(0);

      const entries = inspectJson(image);
      const hello = entries.find((e) => e.path === "/etc/hello");
      expect(hello).toBeDefined();
      expect(hello!.type).toBe("f");
      expect(hello!.mode).toBe("0640");
      expect(hello!.uid).toBe(5);
      expect(hello!.gid).toBe(7);
      expect(hello!.size).toBe("hello, world\n".length);

      // Original entries are still there.
      expect(entries.find((e) => e.path === "/etc/passwd")).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adds a directory with default mode 0755 when --mode omitted", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("add", image, "/etc/conf.d", "--dir");
      expect(r.status).toBe(0);
      const entries = inspectJson(image);
      const d = entries.find((e) => e.path === "/etc/conf.d");
      expect(d).toBeDefined();
      expect(d!.type).toBe("d");
      expect(d!.mode).toBe("0755");
      expect(d!.uid).toBe(0);
      expect(d!.gid).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adds a directory with explicit mode/uid/gid", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run(
        "add", image, "/home/bob",
        "--dir",
        "--mode", "0750",
        "--uid", "1001",
        "--gid", "1001",
      );
      expect(r.status).toBe(0);
      const entries = inspectJson(image);
      const d = entries.find((e) => e.path === "/home/bob");
      expect(d).toBeDefined();
      expect(d!.type).toBe("d");
      expect(d!.mode).toBe("0750");
      expect(d!.uid).toBe(1001);
      expect(d!.gid).toBe(1001);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("adds a symlink with the given target", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run(
        "add", image, "/usr/bin/vi",
        "--symlink", "/usr/bin/sh",
      );
      expect(r.status).toBe(0);
      const entries = inspectJson(image);
      const link = entries.find((e) => e.path === "/usr/bin/vi");
      expect(link).toBeDefined();
      expect(link!.type).toBe("l");
      expect(link!.target).toBe("/usr/bin/sh");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--force allows same-type file overwrite (content replaced)", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const src = join(tmp, "new-passwd");
      writeFileSync(src, "root:x:0:0::/root:/bin/sh\n");
      const r = run(
        "add", image, "/etc/passwd",
        "--file", src,
        "--force",
      );
      expect(r.status).toBe(0);
      const entries = inspectJson(image);
      const passwd = entries.find((e) => e.path === "/etc/passwd");
      expect(passwd!.size).toBe("root:x:0:0::/root:/bin/sh\n".length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prints subcommand usage on `add --help` and exits 0 without modifying image", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const r = run("add", "--help");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("add");
      expect(r.stdout).toContain("--file");
      expect(r.stdout).toContain("--symlink");
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("mkrootfs add — error handling", () => {
  it("exits 1 when parent directory does not exist", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const r = run("add", image, "/nope/missing/file", "--dir");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("parent directory does not exist");
      expect(r.stderr).not.toContain("at ");
      // Image unchanged on failure (atomic write).
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 when target already exists without --force", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const src = join(tmp, "something.txt");
      writeFileSync(src, "x");
      const r = run("add", image, "/etc/passwd", "--file", src);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("already exists");
      expect(r.stderr).toContain("--force");
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 with --force when types differ (file → dir at same path)", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const r = run("add", image, "/etc/passwd", "--dir", "--force");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("cross-type replace not supported");
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 when no operation flag is given", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const r = run("add", image, "/etc/x");
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/missing operation flag|--file|--dir|--symlink/);
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 when multiple operation flags are given", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const src = join(tmp, "x.txt");
      writeFileSync(src, "x");
      const r = run("add", image, "/etc/x", "--file", src, "--dir");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("mutually exclusive");
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 with a clean error when the image file does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-add-"));
    try {
      const r = run("add", join(tmp, "nope.vfs"), "/etc/x", "--dir");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("image not found");
      expect(r.stderr).not.toContain("at ");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 1 when --file source path does not exist", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const before = readFileSync(image);
      const r = run(
        "add", image, "/etc/new",
        "--file", join(tmp, "missing-source.txt"),
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("source file not found");
      expect(r.stderr).not.toContain("at ");
      expect(readFileSync(image).equals(before)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits 2 when <vfs-path> is not absolute", () => {
    const { tmp, image } = buildBasicImage();
    try {
      const r = run("add", image, "etc/x", "--dir");
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("absolute");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
