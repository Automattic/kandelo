import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findRepoRoot } from "../src/binary-tiers";

/**
 * The process worker must still contain the artifact reader after bundling.
 *
 * # Why this test exists
 *
 * The reader is installed by a bare side-effect import in
 * `wasm-artifact-driver.ts`:
 *
 *     import "#wasm-artifact-module-source";
 *
 * `host/package.json` declared `"sideEffects": false`, which tells every
 * bundler that no module in this package does anything on import. That is
 * precisely a licence to delete an import whose only purpose IS its side
 * effect -- so esbuild dropped the loader registration from the process
 * worker's bundle, and every process the platform started outside Vitest
 * failed with "the wasm-artifact module has not been installed in this realm".
 * `run-sortix-tests.sh signal` went to 0 PASS / 32 FAIL, twelve runs of twelve.
 *
 * The Vitest suite stayed green throughout, because a test file imports host
 * source directly and never goes through the bundler. That is the lesson worth
 * keeping: **the suite that proved the change could not see the realm the
 * change broke.** A narrow green does not generalise, and a bundled realm is a
 * different realm.
 *
 * So this asserts the property in the artifact that actually ships to that
 * realm -- the bundle -- rather than asserting that a config key has a
 * particular value. The `sideEffects` allowlist is today's mechanism; if it is
 * ever replaced by an explicit call, a re-export, or a different bundler
 * setting, this test should keep passing on its own terms.
 */

function bundledWorkerEntry(): string {
  const repoRoot = findRepoRoot();
  return execFileSync(
    join(repoRoot, "node_modules", ".bin", "esbuild"),
    [
      "--bundle",
      "--platform=node",
      "--format=esm",
      join(repoRoot, "host", "src", "worker-entry.ts"),
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
}

describe("process worker bundle", () => {
  it("keeps the artifact reader's loader registration after tree shaking", () => {
    const bundle = bundledWorkerEntry();

    // A string only the Node loader carries. Its presence means the module was
    // evaluated into the bundle rather than shaken out; a marker chosen from
    // the loader's own failure message, so it cannot drift away from the code
    // it stands for.
    expect(
      bundle.includes("so no WebAssembly artifact can be read"),
      "the process-worker bundle must still register the artifact reader; "
        + "without it every process fails with \"the wasm-artifact module has "
        + "not been installed in this realm\"",
    ).toBe(true);
  });
});
