import wasiModule32Url from "@wasi-module32-wasm?url";

/**
 * The wasm32 co-resident WASI module's bundler URL.
 *
 * This lives in its OWN module — separate from `browser-kernel-default-artifacts`
 * — so the dynamic import that requires the staged `wasi_module32.wasm`
 * artifact is a single, nameable dependency edge rather than something every
 * default boot drags in eagerly.
 *
 * Unlike `browser-fork-module-artifact`, the artifact is NOT optional in the
 * product sense: it is the browser's entire WASI Preview 1 implementation. A
 * build that cannot supply it cannot run a WASI guest, and the kernel host
 * says so rather than falling back to something that only looks like WASI.
 */
export const browserWasiModule32ArtifactUrl = wasiModule32Url;
