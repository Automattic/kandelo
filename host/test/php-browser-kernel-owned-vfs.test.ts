/**
 * The browser PHPT page is a focused Vite entry rather than an ordinary host
 * unit-test import. Pin its BrowserKernel contract at the source boundary so
 * removal of the worker-owned VFS migration cannot silently return the page to
 * the deleted memfs/init API before a slow browser inventory run notices.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const phpBrowserRunner = join(
  repoRoot,
  "apps/browser-demos/pages/php-test/main.ts",
);

describe("PHP browser worker-owned VFS contract", () => {
  it("boots from an image and stages scripts through the owning worker", () => {
    const source = readFileSync(phpBrowserRunner, "utf8");

    expect(source).toContain("initFromImage({");
    expect(source).toContain("spawnFromVfs(");
    expect(source).toContain("readFileSnapshotFromVfs(");
    expect(source).toContain("writeFileToVfs(");
    expect(source).toContain("unlinkFileFromVfs(");
    expect(source).not.toMatch(/\bmemfs\s*:/);
    expect(source).not.toMatch(/\.init\s*\(/);
  });
});
