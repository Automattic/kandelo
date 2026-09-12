import type { ForkResumeTarget } from "./fork-replay-events";

export const FORK_RESUME_CATALOG_SECTION =
  "kandelo.wpk_fork.resume_catalog";
export const FORK_RESUME_CATALOG_EXPORT = "__wpk_fork_resume_catalog";
export const FORK_RESUME_CATALOG_VERSION = 1;
export const FORK_RESUME_CATALOG_HEADER_SIZE = 12;
export const FORK_RESUME_CATALOG_RECORD_SIZE = 8;

const FORK_RESUME_CATALOG_MAGIC = 0x4352_464b; // "KFRC", little endian.

export interface ForkResumeCatalogRecord {
  readonly functionOrdinal: number;
  readonly localCatalogSlot: number;
}

export interface ForkResumeCatalogTarget extends ForkResumeTarget {
  readonly localCatalogSlot: number;
}

function requireCatalogTable(instance: WebAssembly.Instance): WebAssembly.Table {
  const value = instance.exports[FORK_RESUME_CATALOG_EXPORT];
  if (!(value instanceof WebAssembly.Table)) {
    throw new Error(
      `fork resume catalog is missing table export ${FORK_RESUME_CATALOG_EXPORT}`,
    );
  }
  return value;
}

/**
 * Parse the deterministic function-ordinal to local-table-slot metadata.
 *
 * Result types are deliberately absent: the exact module template chooses the
 * target and the generated Wasm `call_indirect` performs the authoritative
 * recursive/reference-type compatibility check before consuming a frame.
 */
export function readForkResumeCatalog(
  module: WebAssembly.Module,
): readonly ForkResumeCatalogRecord[] {
  const sections = WebAssembly.Module.customSections(
    module,
    FORK_RESUME_CATALOG_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${FORK_RESUME_CATALOG_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength < FORK_RESUME_CATALOG_HEADER_SIZE) {
    throw new Error("fork resume catalog is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== FORK_RESUME_CATALOG_MAGIC) {
    throw new Error("fork resume catalog has invalid magic");
  }
  const version = view.getUint16(4, true);
  if (version !== FORK_RESUME_CATALOG_VERSION) {
    throw new Error(`unsupported fork resume catalog version ${version}`);
  }
  if (view.getUint16(6, true) !== FORK_RESUME_CATALOG_HEADER_SIZE) {
    throw new Error("fork resume catalog has an invalid header size");
  }
  const count = view.getUint32(8, true);
  const expected =
    FORK_RESUME_CATALOG_HEADER_SIZE + count * FORK_RESUME_CATALOG_RECORD_SIZE;
  if (!Number.isSafeInteger(expected) || bytes.byteLength !== expected) {
    throw new Error("fork resume catalog has an invalid size");
  }

  const records: ForkResumeCatalogRecord[] = [];
  const slots = new Set<number>();
  let previousOrdinal: number | undefined;
  for (let index = 0; index < count; index++) {
    const offset =
      FORK_RESUME_CATALOG_HEADER_SIZE + index * FORK_RESUME_CATALOG_RECORD_SIZE;
    const functionOrdinal = view.getUint32(offset, true);
    const localCatalogSlot = view.getUint32(offset + 4, true);
    if (
      previousOrdinal !== undefined
      && functionOrdinal <= previousOrdinal
    ) {
      throw new Error(
        `fork resume catalog function ordinal ${functionOrdinal} is not strictly ordered`,
      );
    }
    if (slots.has(localCatalogSlot)) {
      throw new Error(
        `fork resume catalog repeats local slot ${localCatalogSlot}`,
      );
    }
    previousOrdinal = functionOrdinal;
    slots.add(localCatalogSlot);
    records.push({ functionOrdinal, localCatalogSlot });
  }
  return records;
}

/**
 * Resolve one fresh module instance's local catalog to process registration
 * targets. No function object is serialized; each child performs this pairing
 * again after instantiation.
 */
export function forkResumeTargetsFromInstance(
  module: WebAssembly.Module,
  instance: WebAssembly.Instance,
): readonly ForkResumeCatalogTarget[] {
  const records = readForkResumeCatalog(module);
  const table = requireCatalogTable(instance);
  if (table.length !== records.length) {
    throw new Error(
      `fork resume catalog table has length ${table.length}, expected ${records.length}`,
    );
  }
  return records.map(({ functionOrdinal, localCatalogSlot }) => {
    if (localCatalogSlot >= table.length) {
      throw new Error(
        `fork resume catalog slot ${localCatalogSlot} is out of bounds`,
      );
    }
    const thunk = table.get(localCatalogSlot);
    if (typeof thunk !== "function") {
      throw new Error(
        `fork resume catalog slot ${localCatalogSlot} is not a Wasm function`,
      );
    }
    return {
      functionOrdinal,
      localCatalogSlot,
      thunk: thunk as CallableFunction,
    };
  });
}
