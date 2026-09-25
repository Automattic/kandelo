/**
 * Assemble a fresh child's import objects from the plan the module built.
 *
 * What is left of `ForkImportedGlobalPlanner`, 468 lines in the attic, after
 * the decisions moved into `fork_codec::child_import_plan`: the host no longer
 * matches declarations to binding records, cross-checks their types, hunts for
 * the saved snapshot behind a base import, or refuses the combinations a child
 * cannot reconstruct. It asks the module what to do with each import and does
 * it.
 *
 * Four things here are genuinely host, and each is here for a stated reason:
 *
 *  - An import object is a JavaScript object, and the values it carries are
 *    `WebAssembly.Global` and `WebAssembly.Table` objects. Nothing in wasm can
 *    build one.
 *  - A repeated `(module, name)` import is answered by POSITION -- the Nth read
 *    gets the Nth ordinal's value -- which needs a Proxy over the namespace,
 *    because that is the only place the reads are observable.
 *  - Materializing a reference from a recipe is the one engine floor this
 *    campaign has never been able to move (see the memory on the 2026-09-03
 *    probe).
 *  - Reading `__wpk_fork_global_N` off a provider's instance needs the
 *    instance, which the module cannot hold.
 *
 * Instantiation ORDER is computed here rather than in the module for a narrower
 * reason: the provider edges come from the plan, but a raw reference's edges
 * come from the decoded reference graph, and only the host has both in hand.
 */

import type { ForkWasmImports } from "./fork-import-identity";
import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";

/** `fm_child_import_plan_field` selectors, in the module's match order. */
const FIELD_ORDINAL = 0;
const FIELD_SPACE = 1;
const FIELD_KIND = 2;
const FIELD_TYPE_CODE = 3;
const FIELD_FLAGS = 4;
const FIELD_BITS = 5;
const FIELD_SOURCE_ACTIVATION = 6;
const FIELD_SOURCE_OWNER = 7;

const SPACE_GLOBAL = 0;
/** `WPK_FORK_IMPORTED_GLOBAL_BINDING_*`, read only under `SPACE_GLOBAL`. */
const GLOBAL_RAW_NUMBER = 1;
const GLOBAL_RAW_BIGINT = 2;
const GLOBAL_RAW_REFERENCE = 3;
const GLOBAL_ACTIVATION_GLOBAL = 4;
const GLOBAL_BASE_IMPORT = 5;
/** `WPK_FORK_IMPORTED_TABLE_BINDING_*`, read only under the table space. */
const TABLE_ACTIVATION_TABLE = 1;
const TABLE_BASE_IMPORT = 2;
/** `IMPORT_PLAN_FLAG_SAVED`. */
const FLAG_SAVED = 1;

/** One import of one activation, as the module planned it. */
interface PlanRow {
  readonly ordinal: number;
  readonly space: number;
  readonly kind: number;
  readonly typeCode: number;
  readonly flags: number;
  readonly bits: bigint;
  readonly sourceActivation: number;
  readonly sourceOwner: number;
}

/** The two module entries this reads. */
export interface ForkChildImportPlanSource {
  childImportPlan(activation: number, moduleStateRoot: number): number;
  childImportPlanField(index: number, field: number): bigint;
}

/**
 * What the child's early reference view must answer.
 *
 * Smaller than the replay transaction on purpose: at this point no activation
 * is instantiated, so only raw immutable import values and their owning
 * activation are answerable.
 */
export interface ForkChildReferenceSource {
  /** Which activation must exist before `recipeId` can be materialized. */
  ownerActivation(recipeId: number, typeCode: number): number | null;
  /** The full activation closure, when a typed aggregate needs several. */
  activationDependencies?(recipeId: number, typeCode: number): number[] | undefined;
  materialize(recipeId: number, typeCode: number): unknown;
}

function numberFromF64Bits(bits: bigint): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return view.getFloat64(0, true);
}

export class ForkChildImports {
  private readonly rows = new Map<number, readonly PlanRow[]>();
  private readonly instances = new Map<number, WebAssembly.Instance>();

  constructor(
    source: ForkChildImportPlanSource,
    private readonly modules: ReadonlyMap<number, WebAssembly.Module>,
    moduleStateRoot: number,
    private readonly references: ForkChildReferenceSource,
    private readonly label: string,
  ) {
    // Every activation must already be ADMITTED: the module cannot plan an
    // activation's imports without its KFIG/KFIT sections, which arrive with
    // its admission, and the child asks for the plan before it instantiates
    // anything. See census 175.
    for (const activationId of [...modules.keys()].sort((a, b) => a - b)) {
      const count = source.childImportPlan(activationId, moduleStateRoot);
      const rows: PlanRow[] = [];
      for (let index = 0; index < count; index += 1) {
        rows.push({
          ordinal: Number(source.childImportPlanField(index, FIELD_ORDINAL)),
          space: Number(source.childImportPlanField(index, FIELD_SPACE)),
          kind: Number(source.childImportPlanField(index, FIELD_KIND)),
          typeCode: Number(source.childImportPlanField(index, FIELD_TYPE_CODE)),
          flags: Number(source.childImportPlanField(index, FIELD_FLAGS)),
          // NOT `Number(...)`: this is a 64-bit pattern, and narrowing it here
          // would quietly lose the low bits of an i64 global.
          bits: source.childImportPlanField(index, FIELD_BITS),
          sourceActivation: Number(
            source.childImportPlanField(index, FIELD_SOURCE_ACTIVATION),
          ),
          sourceOwner: Number(source.childImportPlanField(index, FIELD_SOURCE_OWNER)),
        });
      }
      this.rows.set(activationId, rows);
    }
  }

  /**
   * The order the child must instantiate its activations in.
   *
   * Providers before consumers, and ties broken by activation id so the order
   * is the same on every run -- a child that instantiates in a different order
   * than the archive records is a child whose dylink state no longer matches.
   */
  instantiationOrder(): number[] {
    const ids = [...this.rows.keys()].sort((left, right) => left - right);
    const remaining = new Set(ids);
    const order: number[] = [];
    while (remaining.size !== 0) {
      const ready = [...remaining]
        .filter((id) =>
          this.dependenciesFor(id).every((dependency) => !remaining.has(dependency)),
        )
        .sort((left, right) => left - right);
      if (ready.length === 0) {
        throw new Error(
          `${this.label}: import provider cycle among activations ` +
            [...remaining].sort((l, r) => l - r).join(", "),
        );
      }
      for (const id of ready) {
        remaining.delete(id);
        order.push(id);
      }
    }
    return order;
  }

  /** The activations `activationId` must be instantiated after. */
  dependenciesFor(activationId: number): number[] {
    const dependencies = new Set<number>();
    const add = (dependency: number | null | undefined): void => {
      if (dependency === null || dependency === undefined) return;
      if (dependency === activationId) return;
      if (!this.rows.has(dependency)) {
        throw new Error(
          `${this.label}: activation ${activationId} depends on missing ` +
            `provider activation ${dependency}`,
        );
      }
      dependencies.add(dependency);
    };
    for (const row of this.require(activationId)) {
      if (this.isProvider(row)) {
        add(row.sourceActivation);
        continue;
      }
      if (row.space !== SPACE_GLOBAL || row.kind !== GLOBAL_RAW_REFERENCE) continue;
      const recipeId = Number(row.bits);
      // A typed aggregate may need codecs from several earlier activations, so
      // the closure wins when the provider can compute one.
      const closure = this.references.activationDependencies?.(recipeId, row.typeCode);
      if (closure) {
        for (const dependency of closure) add(dependency);
        continue;
      }
      add(this.references.ownerActivation(recipeId, row.typeCode));
    }
    return [...dependencies].sort((left, right) => left - right);
  }

  /**
   * The saved scalar behind a base import, for the dylink loader.
   *
   * A GOT cell is a base import: the loader allocates the fresh `Global`
   * wrapper itself, so the child must not override it, but the parent's saved
   * contents are still authoritative. Duplicate `(module, name)` imports alias
   * that one loader cell, so their snapshots have to agree.
   */
  savedMutableGlobalImport(
    activationId: number,
    moduleName: string,
    importName: string,
  ): number | bigint | undefined {
    const ordinals = this.ordinalsNamed(activationId, moduleName, importName);
    let saved: number | bigint | undefined;
    for (const row of this.require(activationId)) {
      if (row.space !== SPACE_GLOBAL || row.kind !== GLOBAL_BASE_IMPORT) continue;
      if (!ordinals.has(row.ordinal)) continue;
      if ((row.flags & FLAG_SAVED) === 0) {
        throw new Error(
          `${this.label}: base import ${JSON.stringify(moduleName)}.` +
            `${JSON.stringify(importName)} of activation ${activationId} has ` +
            `no saved value; the module snapshots only unshared mutable ` +
            `integer scalars, so this is not the GOT cell the loader expects`,
        );
      }
      const value = row.typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64
        ? BigInt.asUintN(64, row.bits)
        : Number(BigInt.asUintN(32, row.bits));
      if (saved !== undefined && saved !== value) {
        throw new Error(
          `${this.label}: duplicate base imports ${JSON.stringify(moduleName)}.` +
            `${JSON.stringify(importName)} have conflicting saved values`,
        );
      }
      saved = value;
    }
    return saved;
  }

  /**
   * The import object for one activation, over the base imports it would
   * otherwise have received.
   */
  importsForActivation(
    activationId: number,
    baseImports: ForkWasmImports,
  ): ForkWasmImports {
    const module = this.requireModule(activationId);
    // A BASE_IMPORT row is a decision NOT to override: the base import stays,
    // and the loader owns the cell. Leaving it out of this map is how it falls
    // through -- putting it in would resolve it, and there is nothing to
    // resolve it to. The saved-scalar lookup still reads it, off the rows.
    const byOrdinal = new Map<number, PlanRow>();
    for (const row of this.require(activationId)) {
      const base = row.space === SPACE_GLOBAL
        ? row.kind === GLOBAL_BASE_IMPORT
        : row.kind === TABLE_BASE_IMPORT;
      if (!base) byOrdinal.set(row.ordinal, row);
    }

    // Declarations in import-section order, grouped by name. A repeated
    // `(module, name)` is several entries, and the Nth READ of that name binds
    // the Nth entry -- which is the only reason the Proxy below exists.
    const byModule = new Map<string, Map<string, (PlanRow | undefined)[]>>();
    WebAssembly.Module.imports(module).forEach((declaration, ordinal) => {
      let names = byModule.get(declaration.module);
      if (!names) {
        names = new Map();
        byModule.set(declaration.module, names);
      }
      const accesses = names.get(declaration.name) ?? [];
      accesses.push(byOrdinal.get(ordinal));
      names.set(declaration.name, accesses);
    });

    const namespaces = new Map<string, object>();
    for (const [moduleName, names] of byModule) {
      // Only namespaces this activation actually plans an override in need a
      // Proxy; the rest pass through untouched.
      if (![...names.values()].some((accesses) => accesses.some(Boolean))) continue;
      const source = (baseImports[moduleName] ?? {}) as object;
      const reads = new Map<string, number>();
      const resolve = (row: PlanRow): unknown => this.resolve(activationId, row);
      namespaces.set(
        moduleName,
        new Proxy(source, {
          get(target, property, receiver) {
            if (typeof property !== "string") {
              return Reflect.get(target, property, receiver);
            }
            const accesses = names.get(property);
            if (!accesses) return Reflect.get(target, property, receiver);
            const read = reads.get(property) ?? 0;
            if (read >= accesses.length) {
              throw new Error(
                `WebAssembly read reconstructed import ` +
                  `${JSON.stringify(moduleName)}.${JSON.stringify(property)} ` +
                  `more than ${accesses.length} time(s)`,
              );
            }
            reads.set(property, read + 1);
            const row = accesses[read];
            return row ? resolve(row) : Reflect.get(target, property, receiver);
          },
        }),
      );
    }

    return new Proxy(baseImports as object, {
      get(target, property, receiver) {
        if (typeof property === "string" && namespaces.has(property)) {
          return namespaces.get(property);
        }
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

  private isProvider(row: PlanRow): boolean {
    return row.space === SPACE_GLOBAL
      ? row.kind === GLOBAL_ACTIVATION_GLOBAL
      : row.kind === TABLE_ACTIVATION_TABLE;
  }

  private requireModule(activationId: number): WebAssembly.Module {
    const module = this.modules.get(activationId);
    if (!module) throw new Error(`${this.label}: activation ${activationId} is not declared`);
    return module;
  }

  private require(activationId: number): readonly PlanRow[] {
    const rows = this.rows.get(activationId);
    if (!rows) throw new Error(`${this.label}: activation ${activationId} is not declared`);
    return rows;
  }

  /** Import ordinals of `module.name` in one activation's import section. */
  private ordinalsNamed(
    activationId: number,
    moduleName: string,
    importName: string,
  ): Set<number> {
    const module = this.requireModule(activationId);
    const out = new Set<number>();
    WebAssembly.Module.imports(module).forEach((declaration, ordinal) => {
      if (declaration.module === moduleName && declaration.name === importName) {
        out.add(ordinal);
      }
    });
    return out;
  }

  private resolve(activationId: number, row: PlanRow): unknown {
    if (row.space !== SPACE_GLOBAL) {
      if (row.kind !== TABLE_ACTIVATION_TABLE) {
        throw new Error(`${this.label}: table import ${activationId}:${row.ordinal} `
          + `has nothing to resolve to (kind ${row.kind})`);
      }
      return this.providerExport(
        row,
        WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
        (value) => value instanceof WebAssembly.Table,
        "table",
      );
    }
    switch (row.kind) {
      case GLOBAL_RAW_NUMBER:
        return numberFromF64Bits(row.bits);
      case GLOBAL_RAW_BIGINT:
        return BigInt.asIntN(64, row.bits);
      case GLOBAL_RAW_REFERENCE:
        return this.references.materialize(Number(row.bits), row.typeCode);
      case GLOBAL_ACTIVATION_GLOBAL:
        return this.providerExport(
          row,
          WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
          (value) => value instanceof WebAssembly.Global,
          "global",
        );
      default:
        throw new Error(`${this.label}: global import ${activationId}:${row.ordinal} `
          + `has nothing to resolve to (kind ${row.kind})`);
    }
  }

  private providerExport(
    row: PlanRow,
    prefix: string,
    admissible: (value: unknown) => boolean,
    what: string,
  ): unknown {
    const provider = this.instances.get(row.sourceActivation);
    if (!provider) {
      throw new Error(`${this.label}: provider activation ${row.sourceActivation} `
        + `is not instantiated, so it cannot supply ${what} ${row.sourceOwner}`);
    }
    const value = provider.exports[`${prefix}${row.sourceOwner}`];
    if (!admissible(value)) {
      throw new Error(`${this.label}: provider ${what} ${row.sourceActivation}:`
        + `${row.sourceOwner} is missing or is not a WebAssembly ${what}`);
    }
    return value;
  }
}
