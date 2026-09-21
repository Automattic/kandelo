/**
 * The reader for `kandelo.wpk_fork.resume_catalog`, a host-known custom
 * section the instrumenter emits into every fork-instrumented artifact.
 *
 * It answers one question -- which function ordinals does this module declare,
 * and in what order -- and `worker-main.ts` asks it once per activation it
 * seeds into the fork module (`:891`, `:3713`, `:6421`). That is the whole of
 * its production use.
 *
 * # What used to be here, and why it is gone
 *
 * `forkResumeTargetsFromInstance` paired each declared ordinal with the live
 * thunk at its slot in that instance's `__wpk_fork_resume_catalog` table: one
 * `table.get` per fork-instrumented function -- 19,025 per php process start
 * -- to hand the host funcrefs it then wrote into another table the guest
 * already holds. The placement cutover
 * (`docs/superpowers/plans/2026-09-20-fork-resume-thunk-placement.md`) made
 * the pairing unnecessary: the module publishes the whole `(ordinal, slot)`
 * decision and the guest's own emitted shim copies its own thunks across. That
 * left this function with no production caller, and `requireCatalogTable`,
 * `ForkResumeCatalogTarget` and `ForkResumeTarget` existed only to serve it.
 *
 * NO HOST CODE READS A RESUME THUNK ANY MORE. That is what the deletion means;
 * the lines are the consequence.
 */

export const FORK_RESUME_CATALOG_SECTION =
  "kandelo.wpk_fork.resume_catalog";
/**
 * The instance's own catalog table.
 *
 * TEST-ONLY as of the deletion above: nothing in `host/src` reads that table
 * now, and this name survives because `fork-resume-catalog.test.ts` builds its
 * fixtures around it. Kept rather than inlined into the test, because deleting
 * a name a test still uses to make a surface number fall is the incentive
 * `docs/surface-budget.json` warns about in `forkModuleEntriesWithoutProductionCaller`.
 * `fork-resume-table.ts` spells the same string separately, for the length
 * check it makes on the guest it is registering.
 */
export const FORK_RESUME_CATALOG_EXPORT = "__wpk_fork_resume_catalog";
export const FORK_RESUME_CATALOG_VERSION = 1;
export const FORK_RESUME_CATALOG_HEADER_SIZE = 12;
export const FORK_RESUME_CATALOG_RECORD_SIZE = 8;

const FORK_RESUME_CATALOG_MAGIC = 0x4352_464b; // "KFRC", little endian.

export interface ForkResumeCatalogRecord {
  readonly functionOrdinal: number;
  readonly localCatalogSlot: number;
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
