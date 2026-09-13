/**
 * Which `(activation, owner)` coordinate writes a physical table's sparse state.
 *
 * Imported aliases name ONE `WebAssembly.Table`. Only its canonical coordinate
 * writes sparse state; every alias still contributes mutation marks to the
 * shared journal. So something has to decide which coordinate is canonical.
 *
 * That decision is host floor and cannot move: it is made by comparing
 * `WebAssembly.Table` OBJECT IDENTITY, which wasm cannot observe -- there is no
 * `table.eq`, and the fork module does not import the activations' tables at
 * all. See docs/plans/2026-09-12-lane-f-census.md section 50.
 *
 * What does NOT live here is the dirty-page journal those coordinates write
 * into. That is the module's (`__wpk_fork_module_state_table_dirty_*`), and the
 * 3825-line TypeScript arena it used to share a file with is deliberately not
 * coming back.
 */

export class ForkTableStateOwners {
  /** Coordinates seen per physical table, in registration order. */
  private readonly byTable = new WeakMap<WebAssembly.Table, number[]>();
  /** Owner id -> owns the physical table's sparse state. */
  private readonly owns = new Map<number, boolean>();

  constructor(private readonly label = "fork table state owners") {}

  /**
   * Register one coordinate against the physical table it names.
   *
   * The FIRST coordinate registered for a table is its canonical owner and every
   * later alias is not. First rather than lowest id, because registration order
   * is the order activations load, and the canonical owner must be one that
   * already exists when a later alias arrives.
   */
  register(ownerId: number, table: WebAssembly.Table): void {
    if (!Number.isInteger(ownerId) || ownerId < 0) {
      throw new RangeError(`${this.label}: invalid table owner id ${ownerId}`);
    }
    const seen = this.byTable.get(table);
    if (seen === undefined) {
      this.byTable.set(table, [ownerId]);
      this.owns.set(ownerId, true);
      return;
    }
    if (seen.includes(ownerId)) return;
    seen.push(ownerId);
    this.owns.set(ownerId, false);
  }

  /**
   * Whether this coordinate owns its table's sparse state.
   *
   * An unregistered coordinate is NOT an owner. Answering `true` by default
   * would make two aliases both write sparse state for one table, and the
   * duplicate would only surface as a corrupted child.
   */
  ownsState(ownerId: number): boolean {
    return this.owns.get(ownerId) === true;
  }

  /** Forget a coordinate whose activation has unregistered. */
  release(ownerId: number): void {
    this.owns.delete(ownerId);
  }
}
