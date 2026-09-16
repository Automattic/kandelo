import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { binaryTierRoots } from "./binary-tiers";
import { setModuleLoader } from "./wasm-artifact-module-registry";

/**
 * Node's source for the artifact-reader module's bytes.
 *
 * Kept in its own file, and out of `wasm-artifact-driver.ts`, because a static
 * `node:fs` import in the driver would break every browser bundle that reads an
 * artifact, which is all of them. The driver reaches it through the
 * `#wasm-artifact-module-source` subpath in `host/package.json`, whose `browser`
 * condition resolves elsewhere.
 *
 * # Why this registers itself, rather than waiting to be called
 *
 * It used to export `useNodeWasmArtifactModule()`, and every Node entry point
 * had to remember to call it: the process worker, the kernel worker, the
 * main-thread host, the VFS image scripts, the browser app's Vite config, the
 * Vitest setup file. **Four realms forgot**, and not one of them failed with a
 * message about a missing artifact reader -- they failed as a package that
 * would not build, a repo root that could not be found, a kernel "not
 * accepted", and a bundler that could not resolve an alias. "Everyone must
 * remember" has no failure mode that names itself; that was the whole defect.
 *
 * Registration is now a consequence of RESOLUTION. Any realm that can reach the
 * driver has already reached this file, so there is nothing left to forget.
 *
 * An earlier attempt at this was reverted, and the reason is why
 * `binary-tiers.ts` exists. This file used to import `resolverRepoRoot` from
 * `binary-resolver.ts`, which imports the driver, which imports this file.
 * Native ESM tolerates that cycle because both ends are hoisted function
 * declarations; Vitest's SSR transform rewrites imports into bindings that are
 * not, and the suite refused to collect with `Cannot access
 * '__vite_ssr_import_N__' before initialization`. `binary-tiers.ts` is a leaf --
 * it imports nothing from the host runtime -- so the cycle is gone rather than
 * worked around.
 *
 * # Why this resolves by path instead of calling `resolveBinary`
 *
 * `resolveBinary` validates every `.wasm` candidate it considers against the
 * artifact policy -- and the artifact policy is what this module answers.
 * Routing the reader's own bytes through it would mean: resolve the reader,
 * validate the reader, ask the reader whether the reader is valid. That is not
 * a deadlock to work around but a real bootstrap boundary, the same one that
 * makes `kernel.ts` read a pointer width before it can compile a kernel: the
 * thing that judges artifacts cannot be the thing that admits itself.
 *
 * What that gives up is exactly one check, and it is covered better elsewhere:
 * the build verifies the module imports NOTHING and stamps a closure-derived
 * build key, so a stale module fails `verify-fresh`; and
 * `installWasmArtifactModule` refuses a module whose `wa_*` surface or wire
 * version does not match this host.
 *
 * # Why the tiers come from `binary-tiers.ts`
 *
 * They used to be a hand-maintained copy of the resolver's list, and it carried
 * three defects. It had drifted in both directions, as its own comment
 * admitted. It rooted the installed-package tier at `<repo>/host/wasm`, which
 * is only right by accident in a checkout. And -- the one nobody had written
 * down -- it called `resolverRepoRoot()` unguarded before searching, so an
 * INSTALLED consumer, which has no repo root, threw "Could not find repo root"
 * before it could reach its own tier. Since this module is what validates every
 * artifact, an installed consumer could not read any artifact, and so could not
 * boot. Sharing the resolver's roots fixes all three at once, and there is no
 * longer a second list to keep in step.
 */

const MODULE_FILE = "wasm_artifact_module32.wasm";

/**
 * Register the loader.
 *
 * Registered as a LOADER rather than an eager install, so a realm that never
 * reads an artifact never reads `wasm_artifact_module32.wasm` from disk, and
 * importing this file cannot itself trigger a filesystem walk at import time.
 *
 * A missing module is a loud, named failure rather than a fallback: there is no
 * JavaScript reader to fall back to, and a silent fallback is how two of the
 * three previous copies of that reader stayed alive.
 */
export function useNodeWasmArtifactModule(): void {
  setModuleLoader(() => {
    const searched: string[] = [];
    for (const { root } of binaryTierRoots()) {
      const candidate = join(root, MODULE_FILE);
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

useNodeWasmArtifactModule();
