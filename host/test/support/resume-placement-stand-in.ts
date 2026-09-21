/**
 * A JavaScript STAND-IN for the guest's emitted placement shim.
 *
 * # What this is for, and what it must never be read as
 *
 * `ForkResumeTable.registerActivation` publishes one activation's
 * `(ordinal, slot)` decision and hands the resulting `(ptr, count)` to the
 * guest's own `__wpk_fork_place_resume_thunks`. Two things are being tested
 * around that call and they need different fixtures:
 *
 * 1. **Does the module's decision arrive intact, and does the host record and
 *    release the right slots?** That is `fork-resume-table.test.ts` and
 *    `fork-resume-placement-baseline.test.ts`. Both need arbitrary catalogs
 *    and mintable thunks, which means they cannot instantiate a real
 *    SDK-built guest -- a guest's ordinals are whatever its own
 *    instrumentation produced. They use this.
 *
 * 2. **Do the Rust writer and the emitted wasm reader agree about stride,
 *    field order and width?** That is `fork-resume-assignment.test.ts`, which
 *    drives the REAL shim out of `native_fork.instrumented.wasm` over a buffer
 *    the REAL module wrote, in one shared memory. Nothing here can answer that
 *    question, because a stand-in written from the same understanding as the
 *    writer would only be checking this repository against itself.
 *
 * So: this file is not evidence about the seam. It is a fixture for the host
 * behaviour on either side of it. The record layout below is restated from
 * `emit_resume_placement_shim`, and if it ever disagrees with the real shim,
 * `fork-resume-assignment.test.ts` is the test that says so.
 */

/** `(ordinal: u32 @ +0, slot: u32 @ +4)`, stride 8, little-endian. */
const RECORD_BYTES = 8;
const RECORD_ORDINAL_OFFSET = 0;
const RECORD_SLOT_OFFSET = 4;

export interface StandInGuestOptions {
  /** The memory the module published its buffer into. */
  readonly memory: WebAssembly.Memory;
  /** The process resume table the thunks are placed into. */
  readonly resumeTable: WebAssembly.Table;
  /**
   * The activation's declared ordinals, in catalog order.
   *
   * Only the LENGTH reaches production code -- `registerActivation` compares
   * it against the count the module assigned -- but naming the ordinals keeps
   * a caller from building a catalog that does not describe what it seeded.
   */
  readonly ordinals: readonly number[];
  /** The thunk this activation would resume into for `ordinal`. */
  readonly thunkFor: (ordinal: number) => WebAssembly.ExportValue;
}

/**
 * An object shaped like the one export `registerActivation` reads, plus the
 * catalog table whose length it checks.
 *
 * It applies the records the same way the emitted shim does, including the
 * grow (the resume table is declared with no maximum, so it is sized by
 * placement) and the reserved-slot refusal (slot 0 is `resume_peek`'s "run the
 * lexical callee" sentinel and must stay null). The shim TRAPS on slot 0; this
 * throws, which is the nearest thing a JavaScript stand-in has.
 */
export function standInGuest(
  options: StandInGuestOptions,
): WebAssembly.Instance {
  const { memory, resumeTable, ordinals, thunkFor } = options;
  const catalog = new WebAssembly.Table({
    element: "anyfunc",
    initial: ordinals.length,
  });
  const place = (pairs: number, count: number): number => {
    const view = new DataView(memory.buffer);
    for (let index = 0; index < count; index += 1) {
      const at = pairs + index * RECORD_BYTES;
      const ordinal = view.getUint32(at + RECORD_ORDINAL_OFFSET, true);
      const slot = view.getUint32(at + RECORD_SLOT_OFFSET, true);
      if (slot === 0) {
        throw new Error(
          `resume placement: slot 0 is the reserved resume_peek sentinel`,
        );
      }
      if (slot >= resumeTable.length) {
        resumeTable.grow(slot - resumeTable.length + 1);
      }
      resumeTable.set(slot, thunkFor(ordinal));
    }
    return Math.max(count, 0);
  };
  return {
    exports: {
      __wpk_fork_place_resume_thunks: place,
      __wpk_fork_resume_catalog: catalog,
    },
  } as unknown as WebAssembly.Instance;
}
