import {
  readWasmExportDescriptors,
  readWasmFunctionImports,
  readWasmImportDescriptors,
  type WasmFunctionImportType,
} from "./constants";
import { computeForkModuleTemplateId } from "./fork-module-state";
import type { RegisteredModuleReflection } from "./wasm-module-reflection";
import { detectChannelBaseTlsOffset } from "./worker-main";

/** Exact artifact facts consumed by a pthread, without another executable copy. */
export interface PreparedThreadProgram {
  readonly reflection: RegisteredModuleReflection;
  readonly functionImports: readonly WasmFunctionImportType[];
  readonly moduleTemplateId: Uint8Array;
  readonly channelBaseTlsOffset: number;
}

// Owners keep admitted program snapshots immutable. Keying by that snapshot
// also keeps an exec replacement distinct while concurrent clones share work.
// Values retain facts only, never the module-sized input buffer.
const preparedPrograms = new WeakMap<ArrayBuffer, Promise<PreparedThreadProgram>>();

export function prepareThreadProgram(bytes: ArrayBuffer): Promise<PreparedThreadProgram> {
  const existing = preparedPrograms.get(bytes);
  if (existing) return existing;
  const imports = readWasmImportDescriptors(bytes);
  const prepared = (async (): Promise<PreparedThreadProgram> => ({
    reflection: {
      imports,
      exports: readWasmExportDescriptors(bytes),
    },
    functionImports: readWasmFunctionImports(bytes),
    channelBaseTlsOffset: imports.some((entry) =>
      entry.kind === "global" && entry.module === "env" && entry.name === "__channel_base"
    ) ? -1 : detectChannelBaseTlsOffset(bytes),
    moduleTemplateId: await computeForkModuleTemplateId(bytes),
  }))();
  preparedPrograms.set(bytes, prepared);
  // Failed preparation must remain retryable rather than poisoning this image.
  void prepared.catch(() => {
    if (preparedPrograms.get(bytes) === prepared) preparedPrograms.delete(bytes);
  });
  return prepared;
}
