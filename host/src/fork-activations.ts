/**
 * What the host still has to remember about a fork activation.
 *
 * Four fields, and each is here because of something JavaScript can do and the
 * fork-module cannot:
 *
 * - `instance`, because binding a guest function into the module's drive table
 *   is a reference-typed `Table.set`. The module is instantiated BEFORE its
 *   guests -- it supplies their frame-flip imports -- so it cannot import their
 *   exports and the host has to put them where it can reach.
 * - `templateId`, the hash of the module bytes, which only the host holds.
 * - `fixedPrefixSize`, read from the frame-format custom section (which comes
 *   out through `WebAssembly.Module.customSections` and nowhere else), which a
 *   capture needs for every side activation.
 * - `activationId`, the key every seed is published under.
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

/**
 * The merged funcref catalog every instrumented activation exports.
 *
 * Not in `generated/abi.ts` because the generator does not emit it; the name is
 * the one `fork-module-instance.ts` imports the module's own copy under.
 */
const FUNCTION_CATALOG_EXPORT = "__wpk_fork_function_catalog";

/** One live activation. */
export interface ForkActivation {
  readonly activationId: number;
  readonly instance: WebAssembly.Instance;
  readonly fixedPrefixSize: number;
  /**
   * The 32-byte hash of this activation's module bytes.
   *
   * Here because the MODULE needs it and cannot compute it: it writes one
   * `Module` record per activation into the capture arena, and that record is
   * what makes the arena's activation set. Only the host holds the bytes.
   */
  readonly templateId: Uint8Array;
}

/** One side activation, as `fm_parent_begin_capture` reads them. */
export interface ForkSideActivation {
  readonly id: number;
  readonly fixedPrefix: number;
}

/** The module entry registration publishes through. */
export interface ForkActivationDriveSink {
  bindActivationDrive(activationId: number, exports: Record<string, unknown>): void;
  setActivationTemplateId(activationId: number, templateId: Uint8Array): void;
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
  registerCatalog(activationId: number, catalog: WebAssembly.Table): void;
  registerStaticRoots(activationId: number, catalog: WebAssembly.Table): void;
  registerTable(activationId: number, ownerId: number, table: WebAssembly.Table): void;
}

/**
 * The one sink every worker builds, from the four records it keeps.
 *
 * A process worker and a pthread replica each run their OWN fork-module
 * instance and therefore their own catalogs, tables and owner election -- but
 * the wiring between them is identical, and writing it twice is how the replica
 * came to have no sink at all (a dlopen there registered no table, and the
 * first host table mutation failed with "host mutated a Table outside the
 * registered fork catalogs").
 */
export function forkActivationCatalogSink(records: {
  tables: {
    registerCatalog(activationId: number, catalog: WebAssembly.Table): void;
    register(activationId: number, ownerId: number, table: WebAssembly.Table): void;
  };
  merged: { take(activationId: number, catalog: WebAssembly.Table): void };
  mergedStaticRoots: { take(activationId: number, catalog: WebAssembly.Table): void };
  owners: {
    register(activationId: number, ownerId: number, table: WebAssembly.Table): void;
  };
}): ForkActivationCatalogSink {
  return {
    registerCatalog: (activationId, catalog) => {
      records.tables.registerCatalog(activationId, catalog);
      records.merged.take(activationId, catalog);
    },
    registerStaticRoots: (activationId, catalog) => {
      records.mergedStaticRoots.take(activationId, catalog);
    },
    registerTable: (activationId, ownerId, table) => {
      records.tables.register(activationId, ownerId, table);
      records.owners.register(activationId, ownerId, table);
    },
  };
}

export class ForkActivations {
  private readonly live = new Map<number, ForkActivation>();
  private readonly bootstrapped = new Set<number>();

  constructor(
    private readonly drive: ForkActivationDriveSink,
    private readonly label: string,
    private readonly catalogs?: ForkActivationCatalogSink,
  ) {}

  /**
   * Remember an activation and bind its guest functions into the drive table.
   *
   * The bind happens HERE rather than at capture because it is a property of
   * the instance, not of a fork: an unbound slot is a `call_indirect` on null
   * inside the module, which surfaces as a trap in the middle of an unwind
   * rather than as a missing feature at registration.
   */
  register(activation: ForkActivation): void {
    if (this.live.has(activation.activationId)) {
      throw new Error(
        `${this.label}: activation ${activation.activationId} is already registered`,
      );
    }
    this.drive.bindActivationDrive(
      activation.activationId,
      activation.instance.exports as Record<string, unknown>,
    );
    // Before any capture: the module refuses one for an activation whose
    // template id it was never given, because the `Module` record it would
    // write is what a child reads to know this activation exists.
    this.drive.setActivationTemplateId(
      activation.activationId,
      activation.templateId,
    );
    this.publishCatalogs(activation);
    this.live.set(activation.activationId, activation);
  }

  /**
   * Forget an activation whose registration did not complete.
   *
   * A delete, and nothing else. What the coordinator's `unregisterActivation`
   * unwound -- reference tables, journals, prepared state -- belongs to the
   * module, which discards it with the capture rather than per activation.
   */
  forget(activationId: number): void {
    if (!this.live.delete(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is not registered`);
    }
  }

  /**
   * Harvest this activation's static roots, then publish its catalogs.
   *
   * The harvest runs FIRST and before `bootstrap`, because bootstrap consumes
   * the active element segments the harvest reads. A harvest that traps can
   * have populated a strict prefix, so nothing is published from a failed one.
   */
  private publishCatalogs(activation: ForkActivation): void {
    if (!this.catalogs) return;
    const exports = activation.instance.exports as Record<string, unknown>;
    const harvest = exports[WPK_FORK_STATIC_ROOT_HARVEST_EXPORT];
    if (typeof harvest !== "function") {
      throw new Error(
        `${this.label}: activation ${activation.activationId} exports no `
          + `${WPK_FORK_STATIC_ROOT_HARVEST_EXPORT}`,
      );
    }
    (harvest as () => void)();

    const functions = exports[FUNCTION_CATALOG_EXPORT];
    if (!(functions instanceof WebAssembly.Table)) {
      throw new Error(
        `${this.label}: activation ${activation.activationId} exports no `
          + `${FUNCTION_CATALOG_EXPORT} table`,
      );
    }
    this.catalogs.registerCatalog(activation.activationId, functions);

    const staticRoots = exports[WPK_FORK_STATIC_ROOT_CATALOG_EXPORT];
    if (!(staticRoots instanceof WebAssembly.Table)) {
      throw new Error(
        `${this.label}: activation ${activation.activationId} exports no `
          + `${WPK_FORK_STATIC_ROOT_CATALOG_EXPORT} table`,
      );
    }
    this.catalogs.registerStaticRoots(activation.activationId, staticRoots);

    // `__wpk_fork_table_N`: this activation's private tables, one export each.
    // The suffix is the owner ordinal, and a malformed one is a build bug
    // rather than a table to skip -- skipping would silently drop a table from
    // every mutation journal it should appear in.
    for (const [name, value] of Object.entries(exports)) {
      if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
      const suffix = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
      const ownerId = Number(suffix);
      if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(ownerId)) {
        throw new Error(`${this.label}: malformed table catalog export ${name}`);
      }
      if (!(value instanceof WebAssembly.Table)) {
        throw new Error(`${this.label}: table catalog ${name} is not a Table`);
      }
      this.catalogs.registerTable(activation.activationId, ownerId, value);
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
  ordered(): readonly ForkActivation[] {
    return [...this.live.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

  /** The side activations a capture must be told about; activation 0 is not one. */
  sides(): readonly ForkSideActivation[] {
    return this.ordered()
      .filter((activation) => activation.activationId !== 0)
      .map((activation) => ({
        id: activation.activationId,
        fixedPrefix: activation.fixedPrefixSize,
      }));
  }
}
