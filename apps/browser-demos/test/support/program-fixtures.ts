import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../../../../host/src/binary-resolver";

/**
 * Where `scripts/build-programs.sh` writes a test program.
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
export function buildProgramsFixture(
  name: string,
  arch: "wasm32" | "wasm64" = "wasm32",
): string {
  return join(findRepoRoot(), "local-binaries", "programs", arch, name);
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
