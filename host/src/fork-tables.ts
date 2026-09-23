/**
 * The host's half of fork table state: object identity, and slots a `Table`
 * only hands to JavaScript.
 *
 * Three jobs live here, and each is host because of something wasm cannot do,
 * not because it has not been ported yet:
 *
 *  - Turning a mutated `WebAssembly.Table` back into the `(activation, owner)`
 *    coordinate it was registered under. There is no `table.eq`, and the fork
 *    module does not import the activations' tables at all (census 50).
 *  - Reading a table's funcref slots to publish a patch, and writing them back
 *    to apply one. A funcref crossing into JavaScript is a function object, and
 *    deciding WHICH catalog entry it is means comparing function identity.
 *  - Growing a non-nullable typed function table, which needs a real
 *    instance-local initializer value to grow with.
 *
 * What is NOT here is the dirty-page journal these mutations mark. That is the
 * module's (`__wpk_fork_module_state_table_dirty_mark`), which this calls as an
 * ordinary export -- the module serves the same function to the guest, so the
 * host marking a mutation and a guest marking one land in one set.
 *
 * Nor is any record of the activations. This kept three -- each activation's
 * funcref catalog, each coordinate's table, and every table's coordinates --
 * all copies of what registration already had, and none released at `dlclose`.
 * The catalogs and tables are read from the live instances in
 * `ForkActivations`, and a table's coordinate from the ONE owner election in
 * `ForkTableStateOwners`, which is the only part that must be remembered
 * (object identity) and which is released with its activation.
 */

import type {
  DylinkTablePatch,
  DylinkTablePatchRun,
} from "./dylink-planner-wire";
import { type ForkActivation, forkActivationTables } from "./fork-activations";
import { WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT } from "./generated/abi";

/**
 * The module's dirty-page set, reached through its guest-facing export.
 *
 * The page arguments are `bigint`, not `number`, and that is the export's
 * shape rather than a preference: `__wpk_fork_module_state_table_dirty_mark`
 * takes `u64` page numbers, which are `i64` in wasm on BOTH pointer widths, so
 * JavaScript must hand them BigInts. Passing a `number` throws "Cannot convert
 * 0 to a BigInt" from inside `dlopen`, which is where this was found.
 */
export interface ForkTableDirtySink {
  markTablePages(ownerId: number, firstPage: bigint, pageCount: bigint): void;
}

function checkedIndex(value: number | bigint, what: string): bigint {
  const index = typeof value === "bigint" ? value : BigInt(value);
  if (index < 0n || index > (1n << 64n) - 1n) {
    throw new RangeError(`${what} is out of range`);
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`${what} is not an exact index`);
  }
  return index;
}

export class ForkTables {
  constructor(
    private readonly dirty: ForkTableDirtySink,
    private readonly owners: {
      canonical(table: WebAssembly.Table): { ownerId: number } | undefined;
    },
    /** The live activations, ascending by id. */
    private readonly activations: () => readonly ForkActivation[],
    private readonly label: string,
  ) {}

  /**
   * Record that the host mutated `[firstIndex, firstIndex + length)` of a
   * registered table.
   *
   * Marked under the CANONICAL coordinate -- the lowest one registered against
   * this physical table. Aliases name one table, and marking each alias
   * separately would journal the same pages several times under coordinates
   * whose sparse state nobody writes.
   */
  markTableMutation(
    table: WebAssembly.Table,
    firstIndexValue: number | bigint,
    lengthValue: number | bigint,
  ): void {
    if (!(table instanceof WebAssembly.Table)) {
      throw new TypeError(`${this.label}: mutation target is not a Table`);
    }
    const canonical = this.owners.canonical(table);
    if (!canonical) {
      throw new Error(
        `${this.label}: host mutated a Table outside the registered fork catalogs`,
      );
    }
    const firstIndex = checkedIndex(firstIndexValue, "table mutation first index");
    const length = checkedIndex(lengthValue, "table mutation length");
    if (length === 0n) return;
    const end = firstIndex + length;
    if (end > 1n << 64n) {
      throw new RangeError("fork table mutation range exceeds table64");
    }
    const shift = BigInt(WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT);
    const firstPage = firstIndex >> shift;
    const pageCount = ((end - 1n) >> shift) - firstPage + 1n;
    this.dirty.markTablePages(canonical.ownerId, firstPage, pageCount);
  }

  /**
   * Encode one null/funcref mutation as stable activation coordinates.
   *
   * `null` means this range needs the full typed KFMS checkpoint instead:
   * externref, exnref and GC values stay on the module's codec path rather than
   * crossing JavaScript, and a slot this cannot read is one of those.
   */
  captureFuncrefTablePatch(
    activationId: number,
    ownerId: number,
    firstIndexValue: number | bigint,
    lengthValue: number | bigint,
  ): DylinkTablePatch | null {
    const table = this.requireTable(activationId, ownerId);
    const firstIndex = checkedIndex(firstIndexValue, "table patch first index");
    const length = checkedIndex(lengthValue, "table patch length");
    if (length === 0n) {
      throw new Error(`${this.label}: cannot publish an empty table mutation`);
    }
    const end = firstIndex + length;
    if (
      end > BigInt(table.length)
      || end > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new RangeError(
        `${this.label}: table patch range does not match its final Table`,
      );
    }
    const start = Number(firstIndex);
    const runs: DylinkTablePatchRun[] = [];
    for (let offset = 0; offset < Number(length); offset += 1) {
      let value: unknown;
      try {
        value = table.get(start + offset);
      } catch {
        return null; // a slot kind this cannot read
      }
      let recipe: DylinkTablePatchRun["function"];
      if (value === null) {
        recipe = null;
      } else if (typeof value === "function") {
        recipe = this.encodeFunction(value as CallableFunction);
        if (!recipe) return null;
      } else {
        return null;
      }
      const previous = runs.at(-1);
      const sameAsPrevious = previous
        && (previous.function === null
          ? recipe === null
          : recipe !== null
            && previous.function.activationId === recipe.activationId
            && previous.function.ordinal === recipe.ordinal);
      if (sameAsPrevious) {
        runs[runs.length - 1] = {
          length: previous!.length + 1,
          function: previous!.function,
        };
      } else {
        runs.push({ length: 1, function: recipe });
      }
    }
    return { activationId, ownerId, start, tableLength: table.length, runs };
  }

  /** Apply one published patch with THIS worker's own function objects. */
  applyFuncrefTablePatch(patch: DylinkTablePatch): void {
    const table = this.requireTable(patch.activationId, patch.ownerId);
    if (
      patch.generation === undefined
      || !Number.isSafeInteger(patch.start)
      || patch.start < 0
      || !Number.isSafeInteger(patch.tableLength)
      || patch.tableLength < 0
    ) {
      throw new Error(`${this.label}: table patch is not a published recipe`);
    }
    const decoded: { length: number; value: CallableFunction | null }[] = [];
    let changed = 0;
    for (const run of patch.runs) {
      if (!Number.isSafeInteger(run.length) || run.length <= 0) {
        throw new Error(`${this.label}: table patch has an invalid run`);
      }
      const value = run.function === null
        ? null
        : this.decodeFunction(run.function.activationId, run.function.ordinal);
      changed += run.length;
      decoded.push({ length: run.length, value });
    }
    if (patch.start + changed > patch.tableLength) {
      throw new Error(`${this.label}: table patch exceeds its final length`);
    }
    if (table.length > patch.tableLength) {
      throw new Error(`${this.label}: local Table is longer than its patch`);
    }
    if (table.length < patch.tableLength) {
      // A non-nullable typed function table cannot grow with null, so grow with
      // a value the patch itself supplies for the first new coordinate. Every
      // new entry is covered by the runs applied immediately below, so any of
      // them is a safe temporary.
      const growthOffset = table.length - patch.start;
      if (growthOffset < 0 || growthOffset >= changed) {
        throw new Error(
          `${this.label}: table patch cannot reconstruct its growth gap`,
        );
      }
      let remaining = growthOffset;
      const initializer = decoded.find((run) => {
        if (remaining < run.length) return true;
        remaining -= run.length;
        return false;
      })?.value;
      if (initializer === undefined) {
        throw new Error(`${this.label}: table patch has no growth initializer`);
      }
      table.grow(patch.tableLength - table.length, initializer);
    }
    let index = patch.start;
    for (const run of decoded) {
      for (let offset = 0; offset < run.length; offset += 1) {
        table.set(index++, run.value);
      }
    }
    this.markTableMutation(table, patch.start, changed);
  }

  /** Which catalog entry a function object is, by identity. */
  private encodeFunction(
    value: CallableFunction,
  ): { activationId: number; ordinal: number } | null {
    for (const activation of this.activations()) {
      const catalog = this.catalog(activation);
      for (let ordinal = 0; ordinal < catalog.length; ordinal += 1) {
        let entry: unknown;
        try {
          entry = catalog.get(ordinal);
        } catch {
          continue;
        }
        if (entry === value) return { activationId: activation.activationId, ordinal };
      }
    }
    return null;
  }

  private decodeFunction(activationId: number, ordinal: number): CallableFunction {
    const activation = this.activations().find((a) => a.activationId === activationId);
    if (!activation) {
      throw new Error(
        `${this.label}: table patch names activation ${activationId}, which has `
          + `no registered function catalog`,
      );
    }
    const value = this.catalog(activation).get(ordinal);
    if (typeof value !== "function") {
      throw new Error(
        `${this.label}: catalog ${activationId}:${ordinal} holds no function`,
      );
    }
    return value as CallableFunction;
  }

  /** An activation's own funcref catalog, which `ForkActivations` checked at registration. */
  private catalog(activation: ForkActivation): WebAssembly.Table {
    return activation.instance.exports.__wpk_fork_function_catalog as WebAssembly.Table;
  }

  private requireTable(activationId: number, ownerId: number): WebAssembly.Table {
    const activation = this.activations().find((a) => a.activationId === activationId);
    const table = activation
      && forkActivationTables(activation, this.label).find(([owner]) => owner === ownerId)?.[1];
    if (!table) {
      throw new Error(
        `${this.label}: no table is registered at ${activationId}:${ownerId}`,
      );
    }
    return table;
  }
}
