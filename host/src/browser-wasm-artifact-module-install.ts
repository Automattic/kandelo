import { browserWasmArtifactModule32ArtifactUrl } from "./browser-wasm-artifact-module-artifact";
import {
  installWasmArtifactModule,
  wasmArtifactModuleInstalled,
} from "./wasm-artifact-driver";

/**
 * Fetch and install the artifact-reader module in a browser worker.
 *
 * # Why this is explicit, and Node's is a lazy loader
 *
 * Every read of an artifact is synchronous — `kernel.ts` needs a pointer width
 * in the middle of building an import object, and `worker-main.ts` needs a
 * verdict before it compiles a program — so the module has to be instantiated
 * before the first read rather than awaited at it. Node can satisfy that
 * lazily, because its bytes are one synchronous file read away. A browser
 * worker cannot: `fetch` is asynchronous, so the install has to happen at a
 * point that is already `await`-shaped, which is the worker's entry.
 *
 * That is the same asymmetry `kernel.wasm` itself already has between the two
 * hosts, not a Node-first design: the platform-observable behaviour after
 * installation is identical, and each host obtains bytes the way that host
 * obtains bytes.
 *
 * Idempotent, so an entry that runs twice — or a worker whose kernel and
 * process roles share a realm — installs once.
 */
export async function installBrowserWasmArtifactModule(): Promise<void> {
  if (wasmArtifactModuleInstalled()) return;
  const url = browserWasmArtifactModule32ArtifactUrl;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `wasm_artifact_module32.wasm could not be fetched from ${url} `
        + `(HTTP ${response.status}), so no WebAssembly artifact can be `
        + "validated. Build it with `scripts/dev-shell.sh bash "
        + "crates/wasm-artifact-module/build-wasm.sh`.",
    );
  }
  installWasmArtifactModule(await response.arrayBuffer());
}
