import forkModule32Url from "@fork-module32-wasm?url";

/**
 * Phase 6 D5: the wasm32 co-resident fork-module's bundler URL.
 *
 * This lives in its OWN module — separate from `browser-kernel-default-artifacts`
 * — so the dependency edge on the staged `fork_module32.wasm` artifact is a
 * single, nameable import rather than something every module that touches a
 * default artifact drags in.
 *
 * The artifact itself is NOT optional: the fork-module is the browser's only
 * fork reconstructor, so `bootWorker` resolves this URL on every boot and a
 * build that cannot supply the artifact cannot fork.
 */
export const browserForkModule32ArtifactUrl = forkModule32Url;
