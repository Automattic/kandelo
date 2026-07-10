import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { rewriteShellLazyFileUrls } from "../../apps/browser-demos/lib/init/shell-lazy-files";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = resolve(import.meta.dirname, "../..");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");

describe.skipIf(!existsSync(rootfsImage))("PHP browser PHPT lazy assets", () => {
  it("rewrites every canonical rootfs executable URL, including dash, ps, and pgrep", () => {
    const fs = MemoryFileSystem.fromImage(
      new Uint8Array(readFileSync(rootfsImage)),
    );
    const before = fs.exportLazyEntries();
    const expected = new Map([
      ["/usr/bin/dash", "binaries/programs/wasm32/dash.wasm"],
      ["/usr/bin/ps", "binaries/programs/wasm32/posix-utils-lite/ps.wasm"],
      ["/usr/bin/pgrep", "binaries/programs/wasm32/posix-utils-lite/pgrep.wasm"],
    ]);

    for (const [path, url] of expected) {
      expect(before.find((entry) => entry.path === path)?.url).toBe(url);
    }

    rewriteShellLazyFileUrls(fs);
    const after = fs.exportLazyEntries();
    expect(after.filter((entry) => entry.url.startsWith("binaries/"))).toEqual([]);
    for (const [path, sourceUrl] of expected) {
      expect(after.find((entry) => entry.path === path)?.url).not.toBe(sourceUrl);
    }
  });
});
