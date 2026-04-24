import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildImage } from "../src/builder.ts";
import { extractImage } from "../src/extract.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("extract command", () => {
  it("recreates files + dirs on disk and emits a rebuildable MANIFEST", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });

    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-extract-"));
    const imagePath = join(tmp, "rootfs.vfs");
    const outDir = join(tmp, "out");
    writeFileSync(imagePath, image);
    try {
      const manifest = extractImage(imagePath, outDir);

      // Generated MANIFEST captures the tree with honest ownership.
      expect(manifest).toContain("/etc/passwd");
      expect(manifest).toContain("/home/alice");
      expect(manifest).toMatch(/\/home\/alice\s+d\s+0700\s+1000\s+1000/);
      expect(manifest).toMatch(/\/tmp\s+d\s+1777\s+0\s+0/);

      // Extracted file content matches the fixture source.
      const passwd = readFileSync(join(outDir, "rootfs", "etc", "passwd"), "utf8");
      expect(passwd).toContain("root:x:0:0");
      expect(passwd).toContain("daemon:x:1:1");

      // Directories exist on disk (uid/gid not preserved — MANIFEST is source of truth).
      const aliceDir = statSync(join(outDir, "rootfs", "home", "alice"));
      expect(aliceDir.isDirectory()).toBe(true);

      const tmpDir = statSync(join(outDir, "rootfs", "tmp"));
      expect(tmpDir.isDirectory()).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
