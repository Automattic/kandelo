import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const shim = join(here, "..", "bin", "mkrootfs.mjs");

function run(...args: string[]) {
  return spawnSync(shim, args, { encoding: "utf8", cwd: repoRoot });
}

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

  it("inspect/extract/add still print 'not yet implemented'", () => {
    for (const cmd of ["inspect", "extract", "add"]) {
      const r = run(cmd);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`mkrootfs ${cmd}: not yet implemented`);
    }
  });
});

describe("mkrootfs build — happy paths", () => {
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
      const mfs = MemoryFileSystem.fromImage(bytes);
      // pass-1 dir, pass-2 file, pass-3 symlink all present.
      expect(() => mfs.stat("/etc")).not.toThrow();
      expect(() => mfs.stat("/etc/passwd")).not.toThrow();
      expect(mfs.readlink("/usr/bin/sh")).toBe("/bin/dash");
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
