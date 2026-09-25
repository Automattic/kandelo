/**
 * Assemble a fresh child's import objects from the plan the module built.
 *
 * `fm_child_plan` decides everything: which import of which activation gets
 * which value, whether a raw reference's kind fits the declared type, and the
 * order the activations must be instantiated in (`fork_codec::child_plan`).
 * What is left here is only what a host can do:
 *
 *  - An import object is a JavaScript object, and the values it carries are
 *    `WebAssembly.Global` and `WebAssembly.Table` objects. Nothing in wasm can
 *    build one.
 *  - A repeated `(module, name)` import is answered by POSITION -- the Nth read
 *    gets the Nth ordinal's value -- which needs a Proxy over the namespace,
 *    because that is the only place the reads are observable.
 *  - A catalog slot becomes a live reference with a `Table.get`, and a
 *    provider's `__wpk_fork_global_N` is read off its instance. Both need the
 *    instance, which the module cannot hold.
 */

import { FUNCTION_CATALOG_EXPORT } from "./fork-activations";
import type { ForkWasmImports } from "./fork-import-identity";
import type { ForkChildPlan, ForkChildPlanRow } from "./fork-module-backend";
import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";

/** `CHILD_PLAN_RESOLVE_*` in `crates/fork-codec/src/child_plan.rs`. */
const RAW_F64 = 1;
const RAW_I64 = 2;
const NULL = 3;
const FUNC_CATALOG_SLOT = 4;
const STATIC_ROOT_SLOT = 5;
const PROVIDER_GLOBAL = 6;
const PROVIDER_TABLE = 7;
const SAVED_BASE_SCALAR = 8;
const KEEP_BASE = 9;

/** The 64-bit pattern a row carries in `a` (low) and `b` (high). */
const bits = (row: ForkChildPlanRow): bigint => (BigInt(row.b) << 32n) | BigInt(row.a);

export class ForkChildImports {
  private readonly rows = new Map<number, ForkChildPlanRow[]>();
  private readonly instances = new Map<number, WebAssembly.Instance>();
  /** Providers before consumers, as the module ordered them. */
  readonly order: readonly number[];

  constructor(
    plan: ForkChildPlan,
    private readonly modules: ReadonlyMap<number, WebAssembly.Module>,
    private readonly label: string,
  ) {
    this.order = plan.order;
    for (const activationId of plan.order) this.rows.set(activationId, []);
    for (const row of plan.rows) this.require(row.activation).push(row);
  }

  /**
   * The saved scalar behind a base import, for the dylink loader.
   *
   * A GOT cell is a base import: the loader allocates the fresh `Global`
   * wrapper itself, so the child must not override it, but the parent's saved
   * contents are still authoritative. Duplicate `(module, name)` imports alias
   * that one cell; the module refused the plan if their snapshots disagree.
   */
  savedMutableGlobalImport(
    activationId: number,
    moduleName: string,
    importName: string,
  ): number | bigint | undefined {
    const rows = this.require(activationId);
    let saved: number | bigint | undefined;
    WebAssembly.Module.imports(this.requireModule(activationId)).forEach((declaration, ordinal) => {
      if (declaration.module !== moduleName || declaration.name !== importName) return;
      const row = rows.find((candidate) => candidate.ordinal === ordinal);
      if (row?.resolve === KEEP_BASE && declaration.kind === "global") {
        throw new Error(
          `${this.label}: base import ${JSON.stringify(moduleName)}.${JSON.stringify(importName)} `
            + `of activation ${activationId} has no saved value; the module snapshots only `
            + "unshared mutable integer scalars, so this is not the GOT cell the loader expects",
        );
      }
      if (row?.resolve === SAVED_BASE_SCALAR) {
        saved ??= row.typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64 ? bits(row) : row.a;
      }
    });
    return saved;
  }

  /**
   * The import object for one activation, over the base imports it would
   * otherwise have received.
   */
  importsForActivation(activationId: number, baseImports: ForkWasmImports): ForkWasmImports {
    const module = this.requireModule(activationId);
    // A base row is a decision NOT to override: the base import stays, and the
    // loader owns the cell. Leaving it out of this map is how it falls through.
    const byOrdinal = new Map<number, ForkChildPlanRow>();
    for (const row of this.require(activationId)) {
      if (row.resolve !== KEEP_BASE && row.resolve !== SAVED_BASE_SCALAR) byOrdinal.set(row.ordinal, row);
    }

    // Declarations in import-section order, grouped by name. A repeated
    // `(module, name)` is several entries, and the Nth READ of that name binds
    // the Nth entry -- which is the only reason the Proxy below exists.
    const byModule = new Map<string, Map<string, (ForkChildPlanRow | undefined)[]>>();
    WebAssembly.Module.imports(module).forEach((declaration, ordinal) => {
      let names = byModule.get(declaration.module);
      if (!names) byModule.set(declaration.module, (names = new Map()));
      const accesses = names.get(declaration.name) ?? [];
      accesses.push(byOrdinal.get(ordinal));
      names.set(declaration.name, accesses);
    });

    const namespaces = new Map<string, object>();
    for (const [moduleName, names] of byModule) {
      // Only namespaces this activation actually plans an override in need a
      // Proxy; the rest pass through untouched.
      if (![...names.values()].some((accesses) => accesses.some(Boolean))) continue;
      const reads = new Map<string, number>();
      const resolve = (row: ForkChildPlanRow): unknown => this.resolve(row);
      namespaces.set(moduleName, new Proxy((baseImports[moduleName] ?? {}) as object, {
        get(target, property, receiver) {
          const accesses = typeof property === "string" ? names.get(property) : undefined;
          if (!accesses) return Reflect.get(target, property, receiver);
          const read = reads.get(property as string) ?? 0;
          if (read >= accesses.length) {
            throw new Error(
              `WebAssembly read reconstructed import ${JSON.stringify(moduleName)}.`
                + `${JSON.stringify(property)} more than ${accesses.length} time(s)`,
            );
          }
          reads.set(property as string, read + 1);
          const row = accesses[read];
          return row ? resolve(row) : Reflect.get(target, property, receiver);
        },
      }));
    }

    return new Proxy(baseImports as object, {
      get(target, property, receiver) {
        if (typeof property === "string" && namespaces.has(property)) return namespaces.get(property);
        return Reflect.get(target, property, receiver);
      },
    }) as ForkWasmImports;
  }

  registerInstance(activationId: number, instance: WebAssembly.Instance): void {
    this.require(activationId);
    if (this.instances.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} was instantiated twice`);
    }
    this.instances.set(activationId, instance);
  }

  clear(): void {
    this.instances.clear();
  }

  private requireModule(activationId: number): WebAssembly.Module {
    const module = this.modules.get(activationId);
    if (!module) throw new Error(`${this.label}: activation ${activationId} is not declared`);
    return module;
  }

  private require(activationId: number): ForkChildPlanRow[] {
    const rows = this.rows.get(activationId);
    if (!rows) throw new Error(`${this.label}: activation ${activationId} is not declared`);
    return rows;
  }

  private resolve(row: ForkChildPlanRow): unknown {
    switch (row.resolve) {
      case RAW_F64:
        return new Float64Array(new BigUint64Array([bits(row)]).buffer)[0];
      case RAW_I64:
        return BigInt.asIntN(64, bits(row));
      case NULL:
        return null;
      case FUNC_CATALOG_SLOT:
        return this.catalogSlot(row, FUNCTION_CATALOG_EXPORT);
      case STATIC_ROOT_SLOT:
        return this.catalogSlot(row, WPK_FORK_STATIC_ROOT_CATALOG_EXPORT);
      case PROVIDER_GLOBAL:
        return this.providerExport(row.a, `${WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX}${row.b}`, WebAssembly.Global);
      case PROVIDER_TABLE:
        return this.providerExport(row.a, `${WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}${row.b}`, WebAssembly.Table);
      default:
        throw new Error(`${this.label}: import ${row.activation}:${row.ordinal} has nothing to `
          + `resolve to (resolve ${row.resolve})`);
    }
  }

  /** Slot `a` of the owning activation's own catalog table. */
  private catalogSlot(row: ForkChildPlanRow, name: string): unknown {
    const value = (this.providerExport(row.dep, name, WebAssembly.Table) as WebAssembly.Table).get(row.a);
    if (name === FUNCTION_CATALOG_EXPORT && typeof value !== "function") {
      throw new Error(`${this.label}: catalog slot ${row.dep}:${row.a} holds no function`);
    }
    return value;
  }

  private providerExport(activationId: number, name: string, type: typeof WebAssembly.Global | typeof WebAssembly.Table): unknown {
    const provider = this.instances.get(activationId);
    if (!provider) {
      throw new Error(`${this.label}: provider activation ${activationId} is not instantiated, `
        + `so it cannot supply ${name}`);
    }
    const value = provider.exports[name];
    if (!(value instanceof type)) {
      throw new Error(`${this.label}: provider export ${activationId}:${name} is missing or `
        + `is not a WebAssembly.${type.name}`);
    }
    return value;
  }
}
