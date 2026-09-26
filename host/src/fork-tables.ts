/**
 * The host's half of fork table state: turning a `WebAssembly.Table` the
 * dynamic loader mutated into something the fork module can journal.
 *
 * One job lives here, host because of something wasm cannot do: knowing which
 * identity group a `WebAssembly.Table` object is. There is no `table.eq`, and
 * the fork module does not import the activations' tables at all (census 50).
 * The group is the one `ForkImportIdentity` published for the table's
 * `__wpk_fork_table_<owner>` exports, so the two can never disagree.
 *
 * WHAT IS NOT HERE ANY MORE: which `(activation, owner)` coordinate of a
 * shared table WRITES its sparse state. The host used to elect that
 * (`ForkTableStateOwners`) and mark mutations under the winner's owner. The
 * fork module elects now, from the same groups (lane F stage 1H), so this
 * marks by GROUP and the module resolves the group to its elected owner inside
 * `__wpk_fork_module_state_table_dirty_mark` -- the export it also serves to
 * the guest, so a host mark and a guest mark land in one set.
 */

import { WPK_FORK_MODULE_STATE_TABLE_PAGE_SHIFT } from "./generated/abi";

/**
 * The bit that makes the dirty mark's first argument a GROUP rather than a
 * guest's owner ordinal. DUPLICATED from `TABLE_DIRTY_GROUP_FLAG` in
 * `crates/fork-codec/src/bindings.rs`; `host/test/fork-tables.test.ts` pins it.
 */
export const FORK_TABLE_DIRTY_GROUP_FLAG = 0x8000_0000;

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
  markTablePages(groupMark: number, firstPage: bigint, pageCount: bigint): void;
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
  /** Each catalog table's identity group, as published. */
  private readonly groups = new WeakMap<WebAssembly.Table, number>();

  constructor(
    private readonly dirty: ForkTableDirtySink,
    private readonly label: string,
  ) {}

  /** Remember the group a `__wpk_fork_table_<owner>` export was published in. */
  track(table: WebAssembly.Table, group: number): void {
    this.groups.set(table, group);
  }

  /**
   * Record that the host mutated `[firstIndex, firstIndex + length)` of a
   * catalog table.
   *
   * Marked by the table's GROUP: aliases name one physical table, and the
   * module journals the pages under the one coordinate it elected to write
   * that table's sparse state.
   */
  markTableMutation(
    table: WebAssembly.Table,
    firstIndexValue: number | bigint,
    lengthValue: number | bigint,
  ): void {
    if (!(table instanceof WebAssembly.Table)) {
      throw new TypeError(`${this.label}: mutation target is not a Table`);
    }
    const group = this.groups.get(table);
    if (group === undefined) {
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
    this.dirty.markTablePages((FORK_TABLE_DIRTY_GROUP_FLAG | group) >>> 0, firstPage, pageCount);
  }
}
