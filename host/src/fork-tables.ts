/**
 * The host's half of fork table state: object identity, and slots a `Table`
 * only hands to JavaScript.
 *
 * One job lives here, host because of something wasm cannot do: turning a
 * `WebAssembly.Table` the dynamic loader mutated back into the `(activation,
 * owner)` coordinate it was registered under. There is no `table.eq`, and the
 * fork module does not import the activations' tables at all (census 50).
 *
 * WHAT USED TO BE HERE: `captureFuncrefTablePatch` / `applyFuncrefTablePatch`,
 * which read a table's funcref slots into a patch and wrote one back by
 * comparing function objects against every activation's catalog. The fork
 * module does both now, inside the guest, through the guest's own
 * `wpk_fork_module_table_{read,apply}` shims -- no function crosses into
 * JavaScript -- so these and the catalogs they searched had no caller left.
 *
 * What is NOT here is the dirty-page journal these mutations mark. That is the
 * module's (`__wpk_fork_module_state_table_dirty_mark`), which this calls as an
 * ordinary export -- the module serves the same function to the guest, so the
 * host marking a mutation and a guest marking one land in one set.
 */

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

interface Coordinate {
  readonly activationId: number;
  readonly ownerId: number;
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
  /** Every coordinate a physical table is registered under, kept sorted. */
  private readonly byTable = new WeakMap<WebAssembly.Table, Coordinate[]>();

  constructor(
    private readonly dirty: ForkTableDirtySink,
    private readonly label: string,
  ) {}

  /** Register one `(activation, owner)` coordinate against its table. */
  register(activationId: number, ownerId: number, table: WebAssembly.Table): void {
    const coordinates = this.byTable.get(table) ?? [];
    if (!coordinates.some((c) => c.activationId === activationId && c.ownerId === ownerId)) {
      coordinates.push({ activationId, ownerId });
      coordinates.sort((l, r) => l.activationId - r.activationId || l.ownerId - r.ownerId);
      this.byTable.set(table, coordinates);
    }
  }

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
    const coordinates = this.byTable.get(table);
    if (!coordinates || coordinates.length === 0) {
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
    this.dirty.markTablePages(coordinates[0]!.ownerId, firstPage, pageCount);
  }
}
