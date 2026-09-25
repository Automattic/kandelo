/**
 * What the host still has to remember about a fork activation.
 *
 * Two fields, and each is here because of something JavaScript can do and the
 * fork-module cannot:
 *
 * - `instance`, because binding a guest function into the module's drive table
 *   is a reference-typed `Table.set`. The module is instantiated BEFORE its
 *   guests -- it supplies their frame-flip imports -- so it cannot import their
 *   exports and the host has to put them where it can reach.
 * - `activationId`, the key every module fact is published under.
 *
 * What left in lane F stage 1b: `templateId` and `fixedPrefixSize`. Both are
 * now part of the activation's admission (`fm_admit_activation`), which the
 * caller makes before instantiating, and the module decodes the prefix out of
 * the linked-frame section itself -- so the host no longer carries either.
 *
 * What is deliberately NOT here is the 2,098-line registry this replaces. That
 * one wrapped each guest's save/restore/harvest exports in JavaScript objects
 * for the HOST to call; the module calls them through the drive table now, so
 * the wrapper has no reader. Reference state, GC transit and the dirty-page
 * journal are the module's for the same reason -- see census section 157.
 */

import {
  WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";
import { type ForkResumeAssignment, placeForkResumeThunks } from "./fork-resume-table";

/**
 * The merged funcref catalog every instrumented activation exports.
 *
 * Not in `generated/abi.ts` because the generator does not emit it; the name is
 * the one `fork-module-instance.ts` imports the module's own copy under.
 */
export const FUNCTION_CATALOG_EXPORT = "__wpk_fork_function_catalog";

/** One live activation. */
export interface ForkActivation {
  readonly activationId: number;
  readonly instance: WebAssembly.Instance;
}

/** A registered activation, with the static-root base the module placed. */
export interface RegisteredForkActivation extends ForkActivation {
  readonly staticRootBase: number;
}

/** The row `fm_bind_activation` answers for one activation. */
export interface ForkActivationRow {
  readonly driveBase: number;
  readonly funcCatalogBase: number;
  readonly staticRootBase: number;
  readonly resume: ForkResumeAssignment;
}

/** The module entries registration publishes through, and release. */
export interface ForkActivationDriveSink {
  bindActivation(activationId: number, funcCatalogLength: number, staticRootLength: number): ForkActivationRow;
  bindActivationDrive(activationId: number, driveBase: number, exports: Record<string, unknown>): void;
  releaseResumeSlots(activationId: number): number;
}

/**
 * Where an activation's catalogs and private tables go.
 *
 * Registration is the only moment these are all in hand at once, and each has a
 * different consumer -- the funcref catalog answers function identity, the
 * static-root catalog answers a static-root recipe, and the private tables are
 * what a host table mutation is attributed to. The 2,098-line registry did this
 * inside `registerActivation`; this is the part of it that survived.
 */
export interface ForkActivationCatalogSink {
  registerCatalog(base: number, catalog: WebAssembly.Table): void;
  registerStaticRoots(base: number, catalog: WebAssembly.Table): void;
  registerTable(activationId: number, ownerId: number, table: WebAssembly.Table): void;
  /** The one release the host makes: its table-identity election. */
  releaseTables(activationId: number, tables: readonly WebAssembly.Table[]): void;
}

/**
 * The one sink every worker builds.
 *
 * A process worker and a pthread replica each run their OWN fork-module
 * instance and therefore their own catalogs, tables and owner election -- but
 * the wiring between them is identical, and writing it twice is how the replica
 * came to have no sink at all (a dlopen there registered no table, and the
 * first host table mutation failed with "host mutated a Table outside the
 * registered fork catalogs").
 *
 * THE MERGED FUNCTION CATALOG is the table the module imported at init: the
 * module is instantiated BEFORE its guests, so it cannot import a guest's
 * `__wpk_fork_function_catalog`, and the host copies each activation's catalog
 * into the range the MODULE places it at (the lowest gap live activations
 * leave; `fm_bind_activation`'s `func_catalog_base`). Copying keeps funcref identity, which the module's encode scan
 * compares, and it is filled on every worker because that scan serves the
 * parent too. The module also clears the range when the activation is
 * released, so nothing here remembers where it went.
 */
export function forkActivationCatalogSink(records: {
  functionCatalog: WebAssembly.Table;
  mergedStaticRoots: { take(base: number, catalog: WebAssembly.Table): void };
  owners: {
    register(activationId: number, ownerId: number, table: WebAssembly.Table): void;
    releaseActivation(activationId: number, tables: readonly WebAssembly.Table[]): void;
  };
}): ForkActivationCatalogSink {
  return {
    registerCatalog: (base, catalog) => {
      const mirror = records.functionCatalog;
      if (mirror.length < base + catalog.length) mirror.grow(base + catalog.length - mirror.length);
      for (let slot = 0; slot < catalog.length; slot += 1) mirror.set(base + slot, catalog.get(slot));
    },
    registerStaticRoots: (base, catalog) => {
      records.mergedStaticRoots.take(base, catalog);
    },
    registerTable: (activationId, ownerId, table) => {
      records.owners.register(activationId, ownerId, table);
    },
    releaseTables: (activationId, tables) => {
      records.owners.releaseActivation(activationId, tables);
    },
  };
}

/**
 * `__wpk_fork_table_N`: an activation's private tables, one export each.
 *
 * The suffix is the owner ordinal, and a malformed one is a build bug rather
 * than a table to skip -- skipping would silently drop a table from every
 * mutation journal it should appear in. Read from the instance each time it is
 * needed rather than recorded, so a released activation leaves no copy.
 */
export function forkActivationTables(
  activation: ForkActivation,
  label: string,
): Array<[ownerId: number, table: WebAssembly.Table]> {
  const tables: Array<[number, WebAssembly.Table]> = [];
  for (const [name, value] of Object.entries(activation.instance.exports)) {
    if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
    const suffix = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
    if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
      throw new Error(`${label}: malformed table catalog export ${name}`);
    }
    if (!(value instanceof WebAssembly.Table)) {
      throw new Error(`${label}: table catalog ${name} is not a Table`);
    }
    tables.push([Number(suffix), value]);
  }
  return tables;
}

export class ForkActivations {
  private readonly live = new Map<number, RegisteredForkActivation>();
  private readonly bootstrapped = new Set<number>();

  constructor(
    private readonly drive: ForkActivationDriveSink,
    private readonly label: string,
    private readonly catalogs?: ForkActivationCatalogSink,
  ) {}

  /**
   * Remember an activation, bind it in the module, and act on the row.
   *
   * The activation must already be ADMITTED (`fm_admit_activation`, before its
   * instantiation). `fm_bind_activation` then places it and answers one row;
   * what the host does with it is the reference-typed work only it can do:
   * `Table.set` of the drive bindings at the drive base, the guest's own
   * resume-thunk placement, and the funcref and static-root catalog copies at
   * their bases.
   *
   * The bind happens HERE rather than at capture because it is a property of
   * the instance, not of a fork: an unbound slot is a `call_indirect` on null
   * inside the module, which surfaces as a trap in the middle of an unwind
   * rather than as a missing feature at registration. Placement goes straight
   * after the bind because the row's resume pointer names the module's one
   * published buffer, which the next bind rewrites.
   */
  register(activation: ForkActivation): void {
    const { activationId, instance } = activation;
    if (this.live.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is already registered`);
    }
    const exports = instance.exports as Record<string, unknown>;
    // Harvest FIRST: the catalog lengths the module places are read after it,
    // as they always were, and nothing is published from a harvest that traps.
    if (this.catalogs) this.harvest(activationId, exports);
    const functions = this.catalogTable(activationId, exports, FUNCTION_CATALOG_EXPORT);
    const staticRoots = this.catalogTable(activationId, exports, WPK_FORK_STATIC_ROOT_CATALOG_EXPORT);
    const row = this.drive.bindActivation(activationId, functions.length, staticRoots.length);
    this.drive.bindActivationDrive(activationId, row.driveBase, exports);
    placeForkResumeThunks(this.label, activationId, instance, row.resume);
    this.publishCatalogs(activation, row, functions, staticRoots);
    this.live.set(activationId, { activationId, instance, staticRootBase: row.staticRootBase });
  }

  private catalogTable(activationId: number, exports: Record<string, unknown>, name: string): WebAssembly.Table {
    const table = exports[name];
    if (!(table instanceof WebAssembly.Table)) {
      throw new Error(`${this.label}: activation ${activationId} exports no ${name} table`);
    }
    return table;
  }

  /**
   * Release a closed activation, so nothing of it outlives `dlclose`.
   *
   * The MODULE releases everything it holds -- resume slots, records, identity
   * entries, and its ranges of the merged catalogs and the drive table -- in
   * one `fm_resume_slots` op 1. What is left for the host is what only it has:
   * the table-identity election (wasm has no `table.eq`), and its references to
   * the instance, dropped here so the library can be collected.
   *
   * The module goes first: if its release fails, the activation is still live
   * on both sides and the caller can retry.
   */
  forget(activationId: number): void {
    const activation = this.live.get(activationId);
    if (!activation) {
      throw new Error(`${this.label}: activation ${activationId} is not registered`);
    }
    this.drive.releaseResumeSlots(activationId);
    this.catalogs?.releaseTables(
      activationId,
      forkActivationTables(activation, this.label).map(([, table]) => table),
    );
    this.live.delete(activationId);
    this.bootstrapped.delete(activationId);
  }

  /**
   * Release every activation from the module, highest id first, as a process
   * tears its libraries down. The table election is not re-run: nothing
   * mutates a table after this.
   */
  clear(): void {
    for (const { activationId } of [...this.ordered()].reverse()) {
      this.drive.releaseResumeSlots(activationId);
      this.live.delete(activationId);
    }
  }

  /**
   * Harvest this activation's static roots, then publish its catalogs.
   *
   * The harvest runs FIRST and before `bootstrap`, because bootstrap consumes
   * the active element segments the harvest reads. A harvest that traps can
   * have populated a strict prefix, so nothing is published from a failed one.
   */
  private harvest(activationId: number, exports: Record<string, unknown>): void {
    const harvest = exports[WPK_FORK_STATIC_ROOT_HARVEST_EXPORT];
    if (typeof harvest !== "function") {
      throw new Error(
        `${this.label}: activation ${activationId} exports no `
          + `${WPK_FORK_STATIC_ROOT_HARVEST_EXPORT}`,
      );
    }
    (harvest as () => void)();
  }

  private publishCatalogs(
    activation: ForkActivation,
    row: ForkActivationRow,
    functions: WebAssembly.Table,
    staticRoots: WebAssembly.Table,
  ): void {
    if (!this.catalogs) return;
    this.catalogs.registerCatalog(row.funcCatalogBase, functions);
    this.catalogs.registerStaticRoots(row.staticRootBase, staticRoots);
    for (const [ownerId, table] of forkActivationTables(activation, this.label)) {
      this.catalogs.registerTable(activation.activationId, ownerId, table);
    }
  }

  /**
   * Run one activation's module-state bootstrap, once.
   *
   * A plain call into the guest, not a drive-table dispatch: bootstrap happens
   * at instantiation, before any fork exists, so there is no control flow for
   * the module to own. It converts the activation's active element segments,
   * which is destructive -- running it twice would consume segments the first
   * run already took, leaving tables the child cannot rebuild.
   *
   * Marked bootstrapped only AFTER the call returns, so a bootstrap that threw
   * can be retried. That is the registry's order and the reason holds: a guest
   * that trapped part way has not consumed what it did not reach.
   */
  bootstrap(activationId: number): void {
    const activation = this.live.get(activationId);
    if (!activation) {
      throw new Error(`${this.label}: activation ${activationId} is not registered`);
    }
    if (this.bootstrapped.has(activationId)) {
      throw new Error(
        `${this.label}: activation ${activationId} was bootstrapped twice`,
      );
    }
    const bootstrap = activation.instance.exports[WPK_FORK_EXPORT_MODULE_BOOTSTRAP];
    if (typeof bootstrap !== "function") {
      throw new Error(
        `${this.label}: activation ${activationId} exports no ` +
          `${WPK_FORK_EXPORT_MODULE_BOOTSTRAP}()`,
      );
    }
    (bootstrap as () => void)();
    this.bootstrapped.add(activationId);
  }

  /**
   * Every live activation, ascending by id.
   *
   * Ascending because that is the order a capture drives them in and the order
   * a child instantiates them: a side activation can register before a
   * lower-numbered one (a dlopen races nothing), so insertion order is not it.
   */
  ordered(): readonly RegisteredForkActivation[] {
    return [...this.live.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

}
