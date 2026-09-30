import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { rewriteRootfsLazyFileUrls } from "../../apps/browser-demos/lib/init/rootfs-lazy-files";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = resolve(import.meta.dirname, "../..");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs.zst");

describe.skipIf(!existsSync(rootfsImage))("PHP browser PHPT lazy assets", () => {
  it("rewrites every canonical rootfs executable URL, including bash, ps, and pgrep", () => {
    const fs = MemoryFileSystem.fromImage(
      new Uint8Array(readFileSync(rootfsImage)),
    );
    const before = fs.exportLazyEntries();
    const expected = new Map([
      // bash replaced dash as the only shell, including /bin/sh (PR #1403), so
      // /usr/bin/dash is no longer a rootfs lazy entry.
      ["/usr/bin/bash", "binaries/programs/wasm32/bash.wasm"],
      ["/usr/bin/ps", "binaries/programs/wasm32/posix-utils-lite/ps.wasm"],
      ["/usr/bin/pgrep", "binaries/programs/wasm32/posix-utils-lite/pgrep.wasm"],
      ["/usr/bin/sudo-lite", "binaries/programs/wasm32/sudo-lite.wasm"],
      ["/usr/bin/sudo", "binaries/programs/wasm32/sudo/sudo.wasm"],
    ]);

    for (const [path, url] of expected) {
      expect(before.find((entry) => entry.path === path)?.url).toBe(url);
    }

    rewriteRootfsLazyFileUrls(fs);
    const after = fs.exportLazyEntries();
    expect(after.filter((entry) => entry.url.startsWith("binaries/"))).toEqual([]);
    for (const [path, sourceUrl] of expected) {
      expect(after.find((entry) => entry.path === path)?.url).not.toBe(sourceUrl);
    }
  });
});
