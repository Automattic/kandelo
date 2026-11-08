/** Bulk immutable funcref snapshots without a JS visit to every entry. */

/*
 * Deterministic encoding of the following standard table-only helper.
 * It imports no functions, globals or memory, and never calls a guest function.
 * The destination belongs exclusively to this owner and has the source length.
 * A successful copy returns -1; otherwise it returns the first null ordinal.
 *
 * (module
 *   (import "env" "source" (table $source 0 funcref))
 *   (import "env" "snapshot" (table $snapshot 0 funcref))
 *   (func (export "copy") (result i32)
 *     (local $length i32)
 *     (local $ordinal i32)
 *     table.size $source
 *     local.set $length
 *     i32.const 0
 *     i32.const 0
 *     local.get $length
 *     table.copy $snapshot $source
 *     block $done
 *       loop $scan
 *         local.get $ordinal
 *         local.get $length
 *         i32.ge_u
 *         br_if $done
 *         local.get $ordinal
 *         table.get $snapshot
 *         ref.is_null
 *         if
 *           local.get $ordinal
 *           return
 *         end
 *         local.get $ordinal
 *         i32.const 1
 *         i32.add
 *         local.set $ordinal
 *         br $scan
 *       end
 *     end
 *     i32.const -1))
 */
const SNAPSHOT_PROVIDER_BYTES = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
  0x00, 0x01, 0x7f, 0x02, 0x21, 0x02, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x73,
  0x6f, 0x75, 0x72, 0x63, 0x65, 0x01, 0x70, 0x00, 0x00, 0x03, 0x65, 0x6e,
  0x76, 0x08, 0x73, 0x6e, 0x61, 0x70, 0x73, 0x68, 0x6f, 0x74, 0x01, 0x70,
  0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x63, 0x6f,
  0x70, 0x79, 0x00, 0x00, 0x0a, 0x38, 0x01, 0x36, 0x01, 0x02, 0x7f, 0xfc,
  0x10, 0x00, 0x21, 0x00, 0x41, 0x00, 0x41, 0x00, 0x20, 0x00, 0xfc, 0x0e,
  0x01, 0x00, 0x02, 0x40, 0x03, 0x40, 0x20, 0x01, 0x20, 0x00, 0x4f, 0x0d,
  0x01, 0x20, 0x01, 0x25, 0x01, 0xd1, 0x04, 0x40, 0x20, 0x01, 0x0f, 0x0b,
  0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01, 0x0c, 0x00, 0x0b, 0x0b, 0x41,
  0x7f, 0x0b,
);

let providerModule: WebAssembly.Module | undefined;

function compileProviderModule(): WebAssembly.Module {
  return providerModule ??= new WebAssembly.Module(
    SNAPSHOT_PROVIDER_BYTES as BufferSource,
  );
}

/** Copy the audited helper bytes for cross-engine and encoding checks. */
export function forkFunctionCatalogSnapshotBytes(): Uint8Array {
  return SNAPSHOT_PROVIDER_BYTES.slice();
}

export function snapshotFunctionCatalog(
  source: WebAssembly.Table,
  moduleActivation: number,
): WebAssembly.Table {
  const snapshot = new WebAssembly.Table({
    element: "anyfunc", initial: source.length, maximum: source.length,
  });
  const instance = new WebAssembly.Instance(compileProviderModule(), {
    env: { source, snapshot },
  });
  const copy = instance.exports.copy as () => number;
  const invalidOrdinal = copy();
  if (invalidOrdinal !== -1) {
    throw new Error(
      `function catalog ${moduleActivation} has non-function entry ${invalidOrdinal >>> 0}`,
    );
  }
  return snapshot;
}
