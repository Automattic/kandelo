import {
  type DecodedWasmExportDescriptor,
  type DecodedWasmImportDescriptor,
  readWasmExportDescriptors,
  readWasmImportDescriptors,
} from "./constants";

export interface RegisteredModuleReflection {
  readonly imports: readonly DecodedWasmImportDescriptor[];
  readonly exports: readonly DecodedWasmExportDescriptor[];
}

const registeredReflection = new WeakMap<
  WebAssembly.Module,
  RegisteredModuleReflection
>();

/**
 * Bind one compiled module to the exact bytes from which the host created it.
 *
 * WHY: WebKit can compile ABI 43 fork artifacts containing exception-reference
 * imports while `WebAssembly.Module.imports()` throws instead of returning
 * their name/kind descriptors. Kandelo already parses and validates these
 * bytes before admission, so retain that exact ordered reflection alongside
 * the module rather than making browser behavior depend on a weaker engine
 * reflection surface.
 */
export function registerWasmModuleReflection(
  module: WebAssembly.Module,
  bytes: ArrayBuffer | Uint8Array,
): void {
  const exactBytes = bytes instanceof Uint8Array
    ? bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
    : bytes;
  registerWasmModuleReflectionData(module, {
    imports: readWasmImportDescriptors(exactBytes),
    exports: readWasmExportDescriptors(exactBytes),
  });
}

/** Register exact descriptors prepared by the process owner for a pthread. */
export function registerWasmModuleReflectionData(
  module: WebAssembly.Module,
  reflection: RegisteredModuleReflection,
): void {
  registeredReflection.set(module, {
    imports: Object.freeze(
      reflection.imports.map((descriptor) =>
        Object.freeze({ ...descriptor })
      ),
    ),
    exports: Object.freeze(
      reflection.exports.map((descriptor) =>
        Object.freeze({ ...descriptor })
      ),
    ),
  });
}

export function wasmModuleImports(
  module: WebAssembly.Module,
): readonly DecodedWasmImportDescriptor[] {
  return registeredReflection.get(module)?.imports
    ?? (WebAssembly.Module.imports(module) as
      readonly DecodedWasmImportDescriptor[]);
}

export function wasmModuleExports(
  module: WebAssembly.Module,
): readonly DecodedWasmExportDescriptor[] {
  return registeredReflection.get(module)?.exports
    ?? (WebAssembly.Module.exports(module) as
      readonly DecodedWasmExportDescriptor[]);
}
