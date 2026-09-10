import dylinkModule32Url from "@dylink-module32-wasm?url";

/**
 * The standalone dynamic-linking planner's bundler URL.
 *
 * This lives in its OWN module — separate from
 * `browser-kernel-default-artifacts` and from the fork-module's artifact
 * module — so importing it, and therefore requiring the staged
 * `dylink_module32.wasm`, happens only where the planner is actually wanted.
 * A demo build that never loads a shared object does not have to have built
 * the module, which keeps it an optional build output rather than a hard
 * requirement of every browser build.
 *
 * The same shape as `browser-fork-module-artifact.ts`, and for the same
 * reason.
 */
export const browserDylinkModule32ArtifactUrl = dylinkModule32Url;
