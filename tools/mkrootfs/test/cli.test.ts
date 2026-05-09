import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseManifest } from "../src/manifest.ts";

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
      const outDir = join(tmp, "pre-existing");
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
