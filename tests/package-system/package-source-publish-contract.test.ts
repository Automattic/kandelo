import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(
  resolve(repoRoot, "scripts", "publish-package-source.sh"),
  "utf8",
);

describe("package-source publication contract", () => {
  it("rejects a stale runtime projection in the exact publish registry order", () => {
    const sync = script.indexOf('"$KANDELO_ROOT/scripts/sync-package-source.sh"');
    const registry = script.indexOf(
      'export WASM_POSIX_DEPS_REGISTRY="$PACKAGE_SOURCE_ROOT/packages:$KANDELO_ROOT/packages/registry"',
    );
    const projectionCheck = script.indexOf(
      "build-deps program-index-context-check",
    );
    const packageLoop = script.indexOf("while IFS= read -r pkg; do");

    expect(sync).toBeGreaterThan(-1);
    expect(registry).toBeGreaterThan(-1);
    expect(registry).toBeLessThan(sync);
    expect(projectionCheck).toBeGreaterThan(registry);
    expect(projectionCheck).toBeLessThan(sync);
    expect(packageLoop).toBeGreaterThan(sync);
  });

  it("materializes declared program dependencies for source builds", () => {
    const lines = script.split(/\r?\n/);
    const archiveStage = lines.findIndex((line) => line.trim() === "archive-stage \\");
    expect(archiveStage).toBeGreaterThan(-1);

    const invocation = lines.slice(archiveStage, archiveStage + 10);
    const arch = invocation.indexOf('      --arch "$arch" \\');
    const binaries = invocation.indexOf(
      '      --binaries-dir "$KANDELO_ROOT/binaries" \\',
    );
    const out = invocation.indexOf('      --out "$out_dir" \\');

    expect(arch).toBeGreaterThan(-1);
    expect(binaries).toBeGreaterThan(arch);
    expect(out).toBeGreaterThan(binaries);
    expect(script.match(/--binaries-dir/g)).toHaveLength(1);
  });
});
