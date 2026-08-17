/**
 * Tiny eager-import surface for the WASI compatibility path.
 *
 * Split out of `wasi-shim.ts` so worker bootstraps that handle our
 * native channel-syscall binaries (mariadbd, dinit, dash, coreutils,
 * everything compiled by the wasm32-posix toolchain) don't have to
 * pay the parse + JIT cost of the 1300-line WASI translation layer
 * just to run `Array.some()` over a module's imports and answer
 * "does this module import wasi_snapshot_preview1?".
 *
 * The heavy WasiShim class lives in `wasi-shim.ts` and is dynamically
 * imported by `worker-main.ts` only when `isWasiModule()` returns
 * true. For non-WASI workloads (the common case in this repo) it
 * never enters the worker.
 */

/**
 * Detect whether a compiled WebAssembly module is a WASI module.
 *
 * `wasi_snapshot_preview1` is the only WASI version this codebase
 * supports; older `wasi_unstable` modules aren't recognized.
 */
export function isWasiModule(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    imp => imp.module === "wasi_snapshot_preview1",
  );
}

/**
 * Check if a WASI module imports memory (required for shared memory channel).
 */
export function wasiModuleImportsMemory(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    imp => imp.module === "env" && imp.name === "memory" && imp.kind === "memory",
  );
}

/**
 * Check if a WASI module defines its own memory (not supported).
 */
export function wasiModuleDefinesMemory(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.exports(module).some(
    exp => exp.name === "memory" && exp.kind === "memory",
  );
}
