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

/**
 * The tiers `resolveBinary` searches, in its order.
 *
 * This list must stay identical to `binaryCandidateTiers()` in
 * `binary-resolver.ts`, because the whole point of resolving by path is to give
 * up the policy check and NOTHING else. It had drifted in both directions: it
 * omitted `local-binaries/source-only-v1` — the tier a completed local build
 * actually writes, and the resolver's FIRST — and it ranked the installed
 * package's `host/wasm` above `binaries`, which is the reverse of the
 * resolver's order.
 *
 * The consequence was not subtle. A worktree whose only copy of the module was
 * the freshly built one reported "the wasm-artifact module has not been
 * installed in this realm", and since this module is what reads every artifact,
 * that failure propagates to every artifact-policy decision in the host. A
 * worktree that ALSO had an older copy at `local-binaries/` silently read the
 * older one instead of the one the build had just produced — the same
 * two-locations-for-one-artifact defect that lets a stale kernel be served.
 */
const MODULE_TIERS = [
  "local-binaries/source-only-v1",
  "local-binaries",
  "binaries",
  "host/wasm",
] as const;

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
