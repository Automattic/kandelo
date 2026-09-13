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

interface Coordinate {
  readonly activationId: number;
  readonly ownerId: number;
}

/** Ascending by activation, then by owner. The smallest is canonical. */
function before(left: Coordinate, right: Coordinate): number {
  return left.activationId - right.activationId || left.ownerId - right.ownerId;
}

function key(coordinate: Coordinate): string {
  return `${coordinate.activationId}:${coordinate.ownerId}`;
}

export class ForkTableStateOwners {
  /** Coordinates seen per physical table, kept sorted. */
  private readonly byTable = new WeakMap<WebAssembly.Table, Coordinate[]>();
  /** `activation:owner` -> owns the physical table's sparse state. */
  private readonly owns = new Map<string, boolean>();

  constructor(private readonly label = "fork table state owners") {}

  /**
   * Register one coordinate against the physical table it names, and re-elect.
   *
   * The canonical owner is the LOWEST `(activationId, ownerId)`, not the first
   * one registered, and every registration re-runs the election. Those differ:
   * a side activation can load before a lower-numbered one, and "first wins"
   * would then leave the table owned by a coordinate that a later registration
   * should have displaced. The two agree in the common case, which is exactly
   * what makes the difference easy to miss -- activations usually register in
   * ascending order, so the bug only appears when they do not.
   */
  register(activationId: number, ownerId: number, table: WebAssembly.Table): void {
    if (!Number.isInteger(activationId) || activationId < 0) {
      throw new RangeError(`${this.label}: invalid activation id ${activationId}`);
    }
    if (!Number.isInteger(ownerId) || ownerId <= 0 || ownerId > 0xffff_ffff) {
      throw new RangeError(`${this.label}: invalid table owner id ${ownerId}`);
    }
    const coordinate: Coordinate = { activationId, ownerId };
    const seen = this.byTable.get(table) ?? [];
    if (!seen.some((existing) => before(existing, coordinate) === 0)) {
      seen.push(coordinate);
      seen.sort(before);
      this.byTable.set(table, seen);
    }
    this.elect(seen);
  }

  /**
   * Whether this coordinate owns its table's sparse state.
   *
   * An unregistered coordinate is NOT an owner. Answering `true` by default
   * would make two aliases both write sparse state for one table, and the
   * duplicate would only surface as a corrupted child.
   */
  ownsState(activationId: number, ownerId: number): boolean {
    return this.owns.get(key({ activationId, ownerId })) === true;
  }

  /** Forget every coordinate an unregistering activation contributed. */
  releaseActivation(activationId: number, tables: readonly WebAssembly.Table[]): void {
    for (const table of tables) {
      const seen = this.byTable.get(table);
      if (seen === undefined) continue;
      const remaining = seen.filter((c) => c.activationId !== activationId);
      for (const gone of seen.filter((c) => c.activationId === activationId)) {
        this.owns.delete(key(gone));
      }
      if (remaining.length === 0) this.byTable.delete(table);
      else this.byTable.set(table, remaining);
      // Re-elect: removing the canonical coordinate must promote the next one,
      // or the table is left with no writer at all.
      this.elect(remaining);
    }
  }

  private elect(sorted: readonly Coordinate[]): void {
    sorted.forEach((coordinate, index) => {
      this.owns.set(key(coordinate), index === 0);
    });
  }
}
