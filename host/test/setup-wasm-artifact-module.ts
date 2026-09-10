import { useNodeWasmArtifactModule } from "../src/wasm-artifact-module-node";

/**
 * Make the artifact reader available to every test file.
 *
 * Production hosts install it at their entry points — the Node kernel worker,
 * the Node process worker, the Node main-thread host, and the two browser
 * worker entries. A test file imports a host module directly and has no entry
 * point, so without this every suite that touches `constants.ts` would have to
 * repeat the installation.
 *
 * Registered as a LOADER, so a suite that never reads an artifact never reads
 * `wasm_artifact_module32.wasm` from disk. A suite that does read one and finds
 * the module missing fails with a message naming the build command, rather than
 * skipping — the pattern that let 18 real-`dlopen` end-to-end tests report
 * `3 passed | 3 skipped, exit 0` in a fresh worktree while guarding a
 * 6,340-line deletion.
 */
useNodeWasmArtifactModule();
