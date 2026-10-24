import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedBrowserLazyAssetModules } from "../../scripts/generate-browser-lazy-asset-urls";
import { lazyAssetTables, mirrorPath } from "../../scripts/browser-lazy-asset-tables";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The browser's lazy asset URL tables are generated from the metadata the
 * images are built from. A package added to an image needs only that
 * metadata: this fails, with the regeneration command, when the committed
 * tables no longer match it.
 */
describe("generated browser lazy asset URL tables", () => {
  it("match the image metadata they are generated from", () => {
    const stale: string[] = [];
    for (const [path, expected] of generatedBrowserLazyAssetModules()) {
      let actual: string | null = null;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        actual = null;
      }
      if (actual !== expected) stale.push(relative(repoRoot, path));
    }
    expect(
      stale,
      "regenerate with: node node_modules/tsx/dist/cli.mjs scripts/generate-browser-lazy-asset-urls.ts",
    ).toEqual([]);
  });

  it("cover every lazy entry each image declares", () => {
    const tables = lazyAssetTables(repoRoot);
    expect(tables.rootfs.length).toBeGreaterThan(0);
    expect(tables.shell.length).toBeGreaterThan(0);
    expect(tables.archives.length).toBeGreaterThan(0);
    // The rootfs mapping's one eager output is written into the image, not
    // fetched, so it has no URL.
    expect(tables.rootfs.map((entry) => entry.binary))
      .not.toContain("programs/wasm32/login.wasm");
    expect(tables.shell.map((entry) => entry.key)).toContain("programs/termchat.wasm");
  });

  it("spells the default program architecture explicitly", () => {
    expect(mirrorPath("programs/tmux.wasm")).toBe("programs/wasm32/tmux.wasm");
    expect(mirrorPath("programs/wasm32/vim.zip")).toBe("programs/wasm32/vim.zip");
    expect(mirrorPath("programs/wasm64/x.wasm")).toBe("programs/wasm64/x.wasm");
    expect(mirrorPath("kernel.wasm")).toBe("kernel.wasm");
  });
});
