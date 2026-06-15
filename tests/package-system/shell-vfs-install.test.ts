import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("build-shell-vfs-image.sh", () => {
  it("installs shell.vfs.zst into local-binaries so the @binaries import resolves", () => {
    const script = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-shell-vfs-image.sh"),
      "utf8",
    );
    expect(script).toMatch(
      /install_local_binary\s+shell\s+"\$REPO_ROOT\/apps\/browser-demos\/public\/shell\.vfs\.zst"/,
    );
  });
});
