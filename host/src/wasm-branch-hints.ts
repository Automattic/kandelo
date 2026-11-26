import { setFlagsFromString } from "node:v8";

/**
 * Make V8 read the `metadata.code.branch_hint` section of the modules it
 * compiles from now on.
 *
 * WHY: `wasm-memory-instrument` marks the copy-on-write test of each store
 * as unlikely in that section. Node 24 reads the section only under this
 * flag; Node 26 reads it by default. The flag applies to the whole Node
 * process, so every module that the embedder compiles later is affected.
 */
export function enableWasmBranchHints(nodeVersion: string = process.versions.node): void {
  if (!nodeVersion.startsWith("24.")) return;
  setFlagsFromString("--experimental-wasm-branch-hinting");
}
