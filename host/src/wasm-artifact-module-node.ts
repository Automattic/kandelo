import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "./binary-resolver";
import { setWasmArtifactModuleLoader } from "./wasm-artifact-driver";

/**
 * Node's source for the artifact-reader module's bytes.
 *
 * Kept in its own file, and out of `wasm-artifact-driver.ts`, for the same
 * reason `browser-wasm-artifact-module-artifact.ts` is separate: a static
 * `node:fs` import in the driver would break every browser bundle that reads an
 * artifact, which is all of them.
 *
 * # Why this resolves by path instead of calling `resolveBinary`
 *
 * `resolveBinary` validates every `.wasm` candidate it considers against the
 * artifact policy — and the artifact policy is what this module answers. Routing
 * the reader's own bytes through it would mean: resolve the reader, validate the
 * reader, ask the reader whether the reader is valid, resolve the reader. That
 * is not a deadlock to work around but a real bootstrap boundary, the same one
 * that makes `kernel.ts` read a pointer width before it can compile a kernel:
 * the thing that judges artifacts cannot be the thing that admits itself.
 *
 * So the reader is resolved by path, over the same three tiers `resolveBinary`
 * searches and in the same order. What it gives up is exactly one check, and
 * that check is covered better elsewhere:
 *
 *   * the build verifies the module imports NOTHING and stamps a
 *     closure-derived build key, so a stale module fails `verify-fresh`;
 *   * `installWasmArtifactModule` refuses a module whose `wa_*` surface or wire
 *     version does not match this host, which is the mismatch the policy gate
 *     would have been looking for.
 *
 * A missing module is a loud, named failure rather than a fallback: there is no
 * JavaScript reader to fall back to, and a silent fallback is how two of the
 * three previous copies of this code stayed alive.
 */

/** The tiers `resolveBinary` searches, in its order. */
const MODULE_TIERS = ["local-binaries", "host/wasm", "binaries"] as const;

const MODULE_FILE = "wasm_artifact_module32.wasm";

export function useNodeWasmArtifactModule(): void {
  setWasmArtifactModuleLoader(() => {
    const repoRoot = findRepoRoot();
    const searched: string[] = [];
    for (const tier of MODULE_TIERS) {
      const candidate = join(repoRoot, ...tier.split("/"), MODULE_FILE);
      searched.push(candidate);
      if (existsSync(candidate)) return readFileSync(candidate);
    }
    throw new Error(
      `${MODULE_FILE} was not found, so no WebAssembly artifact can be read. `
        + "Build it with `scripts/dev-shell.sh bash "
        + "crates/wasm-artifact-module/build-wasm.sh`.\n"
        + searched.map((path) => `  Looked at: ${path}`).join("\n"),
    );
  });
}
