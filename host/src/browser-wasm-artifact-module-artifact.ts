import wasmArtifactModule32Url from "@wasm-artifact-module32-wasm?url";

/**
 * The standalone WebAssembly-artifact reader's bundler URL.
 *
 * Lives in its OWN module — separate from `browser-kernel-default-artifacts`,
 * the fork-module's artifact module and the dylink-module's — matching the
 * shape those established, so a build imports the artifact it needs and no
 * others.
 *
 * The difference from its three siblings is that this one is NOT optional. The
 * fork-module, the WASI module and the dynamic-linking planner are each wanted
 * only by a boot that forks, runs a WASI guest, or calls `dlopen`. Every boot
 * reads an artifact: the kernel host asks this module for the kernel's own
 * pointer width before it compiles the kernel, and every process worker asks it
 * whether the program it was handed may run at all.
 */
export const browserWasmArtifactModule32ArtifactUrl = wasmArtifactModule32Url;
