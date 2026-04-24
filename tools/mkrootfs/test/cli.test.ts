import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const shim = join(here, "..", "bin", "mkrootfs.mjs");

function run(...args: string[]) {
  return spawnSync(shim, args, { encoding: "utf8", cwd: repoRoot });
}

describe("end-to-end CLI", () => {
  it("prints usage on --help and exits 0", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mkrootfs {build|inspect|extract|add}");
  });

  it("exits non-zero on unknown subcommand", () => {
    const r = run("bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`unknown command "bogus"`);
  });

  it("build → inspect → add → extract pipeline produces consistent output", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-cli-"));
    const imagePath = join(tmp, "rootfs.vfs");
    const payload = join(tmp, "payload.txt");
    const outDir = join(tmp, "extracted");
    writeFileSync(payload, "injected-content\n");
    try {
      const fixture = join(here, "fixtures", "basic");

      // build
      const build = run(
        "build",
        join(fixture, "rootfs"),
        join(fixture, "MANIFEST"),
        "-o", imagePath,
        `--repoRoot=${fixture}`,
      );
      expect(build.status).toBe(0);
      expect(build.stdout).toMatch(/Built: .* bytes/);
      expect(existsSync(imagePath)).toBe(true);

      // inspect
      const inspect = run("inspect", imagePath);
      expect(inspect.status).toBe(0);
      expect(inspect.stdout).toContain("/etc/passwd");
      expect(inspect.stdout).toContain("d0755  0:0");
      expect(inspect.stdout).toMatch(/d0700\s+1000:1000.*\/home\/alice/);

      // add
      const add = run(
        "add",
        imagePath,
        "/srv/hello.txt",
        payload,
        "--mode=0640",
        "--uid=5",
        "--gid=6",
      );
      expect(add.status).toBe(0);

      const afterAdd = run("inspect", imagePath);
      expect(afterAdd.stdout).toContain("/srv/hello.txt");
      expect(afterAdd.stdout).toMatch(/-0640\s+5:6.*\/srv\/hello\.txt/);

      // extract
      const extract = run("extract", imagePath, outDir);
      expect(extract.status).toBe(0);
      expect(existsSync(join(outDir, "MANIFEST"))).toBe(true);
      const passwd = readFileSync(join(outDir, "rootfs", "etc", "passwd"), "utf8");
      expect(passwd).toContain("root:x:0:0");
      const helloFile = readFileSync(join(outDir, "rootfs", "srv", "hello.txt"), "utf8");
      expect(helloFile).toBe("injected-content\n");
      const generated = readFileSync(join(outDir, "MANIFEST"), "utf8");
      expect(generated).toContain("/srv/hello.txt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
