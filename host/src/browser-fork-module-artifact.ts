import forkModule32Url from "@fork-module32-wasm?url";

/**
 * Phase 6 D5: the wasm32 co-resident fork-module's bundler URL.
 *
 * This lives in its OWN module — separate from `browser-kernel-default-artifacts`
 * — so the dependency edge on the staged `fork_module32.wasm` artifact is a
 * single, nameable import rather than something every module that touches a
 * default artifact drags in.
 *
 * The artifact itself is NOT optional at RUNTIME any more: the fork-module is
 * the browser's only fork reconstructor, so `bootWorker` resolves this URL on
 * every boot and a build that cannot supply the artifact cannot fork. The
 * BUILD-graph isolation is why the file still exists, and is the same reason
 * its three siblings do: a static import of this alias from a module the boot
 * path pulls in eagerly would make the staged `fork_module32.wasm` a hard
 * requirement of every browser build.
 *
 * Restored from `attic/fork-typescript-do-not-use/` by maintainer decision on
 * 2026-09-14. The `fork-*.ts` sweep took it by FILENAME; nothing it does is
 * fork capture or replay logic, and `browser-wasi-module-artifact.ts`,
 * `browser-dylink-module-artifact.ts` and
 * `browser-wasm-artifact-module-artifact.ts` -- two lines each, same shape --
 * were never swept. See census sections 162 and 164.
 */
export const browserForkModule32ArtifactUrl = forkModule32Url;
