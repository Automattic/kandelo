import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../../host/src/binary-resolver";

/**
 * Where `scripts/build-programs.sh` writes a test program, given its path
 * under `local-binaries/` (`programs/wasm32/<name>.wasm`).
 *
 * WHY not `resolveBinary`: these are developer/test fixtures, not packages.
 * build-programs.sh compiles them into `local-binaries/programs/<arch>/` and
 * refuses to populate any package-owned path, so no package projection can
 * contain them. Local browser runs need the SourceOnly resolution policy
 * (`./run.sh prepare-browser` sets it) so the app's dev server serves the
 * verified gallery images, and under that policy the package resolver serves
 * only the projection: resolving a fixture through it fails even when the
 * fixture is built. Name the fixture's canonical location instead.
 *
 * Returns the path without checking it, so a module-level constant cannot
 * abort test collection for the whole suite; call `requireBuiltFixtures`
 * from the owning spec so a missing fixture fails that spec loudly.
 */
/*
 * Callers spell out that whole path, not a bare file name, so each
 * fixture's consumers stay findable by the path recorded in
 * tests/test-artifacts/kernel-test-programs.json; its ownership test
 * greps for exactly that string.
 */
export function buildProgramsFixture(localBinariesPath: string): string {
  return join(findRepoRoot(), "local-binaries", localBinariesPath);
}

/** Fail with the build command if any fixture has not been built. */
export function requireBuiltFixtures(paths: readonly string[]): void {
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `test fixture(s) not built: ${missing.join(", ")}. `
        + "Run: scripts/dev-shell.sh bash scripts/build-programs.sh",
    );
  }
}
