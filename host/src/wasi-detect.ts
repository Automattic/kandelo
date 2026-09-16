/**
 * Tiny eager-import surface for the WASI compatibility path.
 *
 * This is a pure predicate over a compiled module's import list: "does this
 * module import `wasi_snapshot_preview1`?". It stays in its own file so worker
 * bootstraps that handle our native channel-syscall binaries (mariadbd, dinit,
 * dash, coreutils, everything compiled by the wasm32-posix toolchain) can
 * import it eagerly without pulling in the WASI hosting path at all.
 *
 * The implementation those workers avoid is `wasi-module-instance.ts`, which
 * `worker-main.ts` imports dynamically only when `isWasiModule()` returns
 * true. WASI itself is no longer TypeScript: it is the co-resident Rust
 * `crates/wasi-module`, and this file's job is only to decide whether to go
 * and get it.
 */
import {
  wasmModuleExports,
  wasmModuleImports,
} from "./wasm-module-reflection";

/**
 * Detect whether a compiled WebAssembly module is a WASI module.
 *
 * `wasi_snapshot_preview1` is the only WASI version this codebase
 * supports; older `wasi_unstable` modules aren't recognized.
 */
export function isWasiModule(module: WebAssembly.Module): boolean {
  return wasmModuleImports(module).some(
    imp => imp.module === "wasi_snapshot_preview1",
  );
}

/**
 * Check if a WASI module imports memory (required for shared memory channel).
 */
export function wasiModuleImportsMemory(module: WebAssembly.Module): boolean {
  return wasmModuleImports(module).some(
    imp => imp.module === "env" && imp.name === "memory" && imp.kind === "memory",
  );
}

/**
 * Check if a WASI module defines its own memory (not supported).
 */
export function wasiModuleDefinesMemory(module: WebAssembly.Module): boolean {
  return wasmModuleExports(module).some(
    exp => exp.name === "memory" && exp.kind === "memory",
  );
}
