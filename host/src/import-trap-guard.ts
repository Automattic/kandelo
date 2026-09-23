import {
  readWasmFunctionImports,
  type WasmFunctionImportType,
  type WasmFunctionSignature,
  type WasmValueType,
} from "./constants";

/**
 * Keep a nested Wasm trap a trap when it crosses a JavaScript import frame.
 *
 * A guest function import implemented in JavaScript can call back into Wasm.
 * If that nested call traps, the engine surfaces the trap in the JS frame as a
 * `WebAssembly.RuntimeError`. Letting that JS object propagate back into the
 * calling Wasm would turn it into an ordinary JSTag exception, which a guest
 * `catch_all`/`catch_all_ref` can catch -- a trap made catchable merely by
 * passing through JS. Each wrapped import re-raises such an error as a fresh,
 * genuine trap instead. Every other thrown value, and every return value, is
 * passed through exactly.
 */

function buildFatalTrap(): () => never {
  // (module (func (export "trap") unreachable))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00,
    0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
  ]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const trap = instance.exports.trap;
  if (typeof trap !== "function") {
    throw new Error("failed to construct the import trap guard's fatal trap");
  }
  return (): never => {
    trap();
    throw new Error("unreachable import trap guard fatal trap returned");
  };
}

const fatalTrap = buildFatalTrap();

/**
 * Whether to log the ORIGIN of a trap before it is re-raised. Opt-in because
 * the same boundary carries the expected child-exit teardown trap on every
 * successful fork. Reads `WASM_POSIX_FORK_TRAP_DIAG=1` (Node) or
 * `globalThis.__wpkForkTrapDiag` truthy (browser); safe when neither exists.
 */
function trapDiagnosticsEnabled(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    if (env && env.WASM_POSIX_FORK_TRAP_DIAG === "1") return true;
  } catch {
    // no `process` in this host
  }
  try {
    if ((globalThis as { __wpkForkTrapDiag?: unknown }).__wpkForkTrapDiag) {
      return true;
    }
  } catch {
    // no accessible global flag
  }
  return false;
}

function rethrowPreservingTraps(
  sourceImportOrdinal: number,
  thrown: unknown,
): never {
  if (thrown instanceof WebAssembly.RuntimeError) {
    // `fatalTrap()` DISCARDS this RuntimeError's message and stack to keep the
    // trap uncatchable, which also hides where it came from (a fork-module
    // trap used to surface only as a bare `unreachable`). Surface the origin
    // on the error channel when trap diagnostics are enabled. The log is
    // opt-in because the expected child-exit teardown trap (`kernel_exit` ->
    // `unreachable`) crosses this boundary on every successful fork.
    if (trapDiagnosticsEnabled()) {
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[fork] fatal trap crossing worker-local import ` +
            `ordinal=${sourceImportOrdinal}: ${thrown.message}\n${thrown.stack ?? ""}`,
        );
      } catch {
        // Never let logging change the trap path.
      }
    }
    return fatalTrap();
  }
  throw thrown;
}

/**
 * Vectors and exception/continuation references cannot enter a JavaScript host
 * function: the JS embedding rejects v128/exnref and has no continuation
 * reference conversion. A direct imported Wasm function is valid for them, so
 * such an import is left unwrapped.
 */
function requiresDirectWasmBoundary(type: WasmValueType): boolean {
  if (
    type.code === 0x7b // v128
    || type.code === 0x69 // exnref
    || type.code === 0x74 // noexnref
    || type.code === 0x68 // contref
    || type.code === 0x75 // nocontref
  ) {
    return true;
  }
  return (
    (type.code === 0x62 || type.code === 0x63 || type.code === 0x64)
    && (
      type.heapType === -23 // exn
      || type.heapType === -12 // noexn
      || type.heapType === -24 // cont
      || type.heapType === -11 // nocont
    )
  );
}

function signatureRequiresDirectWasmBoundary(
  signature: WasmFunctionSignature,
): boolean {
  return (
    signature.paramTypes.some(requiresDirectWasmBoundary)
    || signature.resultTypes.some(requiresDirectWasmBoundary)
  );
}

/**
 * Wrap one function import so a nested Wasm trap stays a trap. Imports whose
 * signature needs a direct Wasm boundary are returned unchanged.
 */
export function guardFunctionImport(
  imported: WasmFunctionImportType,
  implementation: CallableFunction,
): CallableFunction {
  if (signatureRequiresDirectWasmBoundary(imported.signature)) {
    return implementation;
  }
  const sourceImportOrdinal = imported.importOrdinal;
  return function (this: unknown, ...args: unknown[]): unknown {
    try {
      return Reflect.apply(implementation, this, args);
    } catch (thrown) {
      return rethrowPreservingTraps(sourceImportOrdinal, thrown);
    }
  };
}

/**
 * Parse the artifact once and guard every function import in a conventional
 * import object. The dynamic linker instead calls `guardFunctionImport` at its
 * final property-resolution boundary.
 */
export function guardImportObject(
  programBytes: ArrayBuffer,
  imports: WebAssembly.Imports,
): WebAssembly.Imports {
  const firstByKey = new Map<string, WasmFunctionImportType>();
  for (const imported of readWasmFunctionImports(programBytes)) {
    const key = `${imported.module.length}:${imported.module}${imported.name}`;
    if (!firstByKey.has(key)) firstByKey.set(key, imported);
  }

  const guarded: WebAssembly.Imports = { ...imports };
  const modules = new Map<string, Record<string, WebAssembly.ImportValue>>();
  for (const imported of firstByKey.values()) {
    const originalModule = imports[imported.module] as
      | Record<string, WebAssembly.ImportValue>
      | undefined;
    if (!originalModule) continue;
    let guardedModule = modules.get(imported.module);
    if (!guardedModule) {
      guardedModule = { ...originalModule };
      modules.set(imported.module, guardedModule);
      guarded[imported.module] = guardedModule;
    }
    const implementation = originalModule[imported.name];
    if (typeof implementation !== "function") continue;
    guardedModule[imported.name] = guardFunctionImport(
      imported,
      implementation,
    ) as WebAssembly.ImportValue;
  }
  return guarded;
}
