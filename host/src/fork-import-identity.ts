/**
 * The two facts about an activation's imports that only JavaScript holds.
 *
 * WHAT WEBASSEMBLY RESOLVED. An import object is a JavaScript object, and its
 * namespaces may be proxies or carry getters, so the value a `WebAssembly.Global`
 * import actually binds to is observable only at instantiation and only from
 * here. The fork module cannot see an activation's import object at all.
 *
 * WHICH OBJECTS ARE THE SAME OBJECT. Two activations importing one Global, or
 * one importing what another exports, is JavaScript reference equality. Wasm
 * has no `global.eq` or `table.eq`, and the module does not import the
 * activations' globals or tables, so this cannot be computed anywhere else.
 *
 * Everything else about a binding is the module's: which catalog entry PROVIDES
 * a shared object (that needs the KFIG/KFIT sections, which the module
 * decodes at admission and the host does not), the type code, the recipe id for a
 * reference, the ordering and the encoding. See census sections 152 and 154.
 *
 * So this file publishes identity and values, and nothing else. It does not
 * decide, and it does not keep a copy of anything the module now owns.
 */
import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
  WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";
import { wasmModuleImports } from "./wasm-module-reflection";

/** `fm_set_identity_group` / `fm_set_import_provenance` spaces. */
export const FORK_IMPORT_SPACE_GLOBAL = 0;
export const FORK_IMPORT_SPACE_TABLE = 1;

export type ForkWasmImports = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** The two module entries this publishes through. */
export interface ForkImportSeedSink {
  setIdentityGroup(
    space: number,
    activationId: number,
    ownerId: number,
    groupId: number,
  ): void;
  setImportProvenance(
    space: number,
    consumerActivation: number,
    importOrdinal: number,
    kind: number,
    groupId: number,
    rawBits: bigint,
  ): void;
}

export interface PreparedForkParentActivation {
  readonly imports: ForkWasmImports;
  complete(instance: WebAssembly.Instance): void;
  abort(): void;
}

/** One import declaration, by its position in the module's import section. */
interface Declaration {
  readonly ordinal: number;
  readonly space: number | null;
}

/** The catalog export prefix each import space is named by. */
const CATALOGS = [
  [FORK_IMPORT_SPACE_GLOBAL, WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX],
  [FORK_IMPORT_SPACE_TABLE, WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX],
] as const;

const f64 = new DataView(new ArrayBuffer(8));

function f64Bits(value: number): bigint {
  f64.setFloat64(0, value, true);
  return f64.getBigUint64(0, true);
}

function catalogOwner(name: string, prefix: string, label: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const text = name.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${label}: malformed catalog export ${name}`);
  }
  return Number(text);
}

/**
 * Imports the FORK RUNTIME binds itself, which have no application provenance.
 *
 * Two kinds, and both are excluded for the same reason: `KFIG`/`KFIT` describe
 * an activation's own imported globals and tables, and neither of these is one.
 * Publishing provenance for them gave the module a record with no declaration
 * to match, and it refused the whole capture -- which is what
 * `fm_parent_begin_capture failed with errno 22` was, for every fork-
 * instrumented program.
 *
 *  - `env.__channel_base`: the process's syscall channel, rebound per worker
 *    rather than reconstructed. The instrumenter excludes it by this exact name
 *    (`imported_global_is_child_binding`), and the two sides cannot share a
 *    constant because the exclusion lives in a wasm transform.
 *  - Everything under `__wpk_fork_`: the resume table, the anyref transit
 *    table, the activation id, the table-generation address. The host binds
 *    each of them from the fork module or its own floor, so a child gets them
 *    the same way its parent did and there is nothing to record.
 */
function forkRuntimeBindsItself(moduleName: string, name: string): boolean {
  if (moduleName !== "env") return false;
  return name === "__channel_base" || name.startsWith("__wpk_fork_");
}

export class ForkImportIdentity {
  /**
   * Group id per distinct object, across every activation.
   *
   * A `WeakMap` because the ids exist only to say "these catalog entries are
   * one object" -- nothing here should keep a Global or Table alive, and the
   * module never sees the objects at all, only the ids.
   */
  private readonly groups = new WeakMap<object, number>();
  private nextGroup = 1;
  private readonly preparing = new Set<number>();

  /**
   * `tables` is the OTHER election over the same objects, and it is deliberately
   * not this one: which coordinate WRITES a shared table's sparse state, rather
   * than which one provides the object to a child. That one is made here because
   * it needs no KFIT -- lowest coordinate wins outright -- and it is fed from
   * this walk so the catalog exports are read once rather than twice.
   */
  constructor(
    private readonly sink: ForkImportSeedSink,
    private readonly label: string,
    private readonly tables?: {
      register(activationId: number, ownerId: number, table: WebAssembly.Table): void;
    /**
     * Publish catalog identities at all. FALSE for a vfork BORROWED child.
     *
     * A borrowed child runs in the PARKED PARENT's linear memory and must leave
     * it exactly as it found it -- `process-lifecycle.ts` refuses the teardown
     * otherwise ("exited without exact ownership fences"). Identity storage is
     * on-demand `SYS_MMAP` chunks in that shared memory, and WRITING one dirties
     * a page the parent owns. Measured: allocating a chunk and writing nothing
     * leaves P-08 green; writing to it exits the child 139.
     *
     * Nothing is lost by skipping. Identities exist for CAPTURE -- the module
     * reads them only in `write_imported_global_bindings` and the KFBT table
     * record -- and a borrowed child never captures; it drives one replay and
     * exits. Publishing into it was always work with no reader.
     */
    }, private readonly publishIdentities = true,
  ) {}

  /**
   * Wrap an activation's import object so every read is recorded.
   *
   * Its KFIG/KFIT sections are not seeded here any more: they are part of the
   * activation's admission (`fm_admit_activation`), which the caller makes
   * before instantiating, and the module refuses a malformed one there.
   */
  prepareActivation(
    activationId: number,
    module: WebAssembly.Module,
    imports: ForkWasmImports,
  ): PreparedForkParentActivation {
    if (this.preparing.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is already prepared`);
    }
    this.preparing.add(activationId);

    // Ordinals are positions in the WHOLE import section, which is how
    // `fork_instrument` numbered them (`module.imports.iter().enumerate()`), so
    // the module can match a provenance record to its KFIG/KFIT declaration
    // without the host reading either section.
    const byKey = new Map<string, Declaration[]>();
    wasmModuleImports(module).forEach((declaration, ordinal) => {
      const key = `${declaration.module}\u0000${declaration.name}`;
      const space = declaration.kind === "global"
        ? FORK_IMPORT_SPACE_GLOBAL
        : declaration.kind === "table"
          ? FORK_IMPORT_SPACE_TABLE
          : null;
      byKey.set(key, [...(byKey.get(key) ?? []), { ordinal, space }]);
    });

    const values = new Map<number, unknown>();
    let finished = false;
    const finish = (): void => {
      if (finished) {
        throw new Error(`${this.label}: activation ${activationId} is finished`);
      }
      finished = true;
      this.preparing.delete(activationId);
    };
    return {
      imports: this.recording(imports, byKey, values),
      complete: (instance) => {
        finish();
        this.publishCatalogs(activationId, instance);
        this.publishProvenance(activationId, byKey, values);
      },
      abort: finish,
    };
  }

  /**
   * Wrap each namespace so every import read is recorded against its ordinal.
   *
   * Reads are counted PER `(module, name)` rather than resolved once: one name
   * may be imported several times, a getter may legally answer differently each
   * time, and WebAssembly performs each declaration's own conversion. Collapsing
   * them would record one value for several distinct bindings.
   */
  private recording(
    imports: ForkWasmImports,
    byKey: ReadonlyMap<string, Declaration[]>,
    values: Map<number, unknown>,
  ): ForkWasmImports {
    const wrapped: Record<string, Readonly<Record<string, unknown>>> = {
      ...imports,
    };
    for (const [namespace, source] of Object.entries(imports)) {
      const reads = new Map<string, number>();
      wrapped[namespace] = new Proxy(source as object, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver);
          if (typeof property !== "string") return value;
          const declarations = byKey.get(`${namespace}\u0000${property}`) ?? [];
          const nth = reads.get(property) ?? 0;
          reads.set(property, nth + 1);
          const declaration = declarations[nth];
          if (declaration?.space !== null && declaration !== undefined) {
            values.set(declaration.ordinal, value);
          }
          return value;
        },
      }) as Readonly<Record<string, unknown>>;
    }
    return wrapped;
  }

  /** Publish this activation's catalog entries into their identity groups. */
  private publishCatalogs(activationId: number, instance: WebAssembly.Instance): void {
    // Table registration still runs below: it is host-side bookkeeping in this
    // realm, not a write into the parent's memory. Only the module publish is
    // skipped.
    for (const [name, value] of Object.entries(instance.exports)) {
      for (const [space, prefix] of CATALOGS) {
        const owner = catalogOwner(name, prefix, this.label);
        if (owner === null) continue;
        if (this.publishIdentities) this.sink.setIdentityGroup(space, activationId, owner, this.group(value as object));
        if (space === FORK_IMPORT_SPACE_TABLE && value instanceof WebAssembly.Table) {
          this.tables?.register(activationId, owner, value);
        }
      }
    }
  }

  /**
   * Publish what each imported global or table turned out to be.
   *
   * The kinds here are only the ones the host can KNOW. `BASE_IMPORT` is absent
   * on purpose: saying it would claim that no activation provides the object,
   * which is the module's election to make. A value that is neither a Global nor
   * a scalar is published as `RAW_REFERENCE`; the module honours that only for a
   * reference type code and refuses it otherwise, rather than guessing.
   */
  private publishProvenance(
    activationId: number,
    byKey: ReadonlyMap<string, Declaration[]>,
    values: ReadonlyMap<number, unknown>,
  ): void {
    for (const [key, declarations] of byKey) {
      // The one import the instrumenter deliberately leaves OUT of KFIG, so
      // the module has no declaration to match provenance against.
      // `imported_global_is_child_binding` in
      // `crates/fork-instrument/src/module_state.rs` excludes it by the same
      // name: it is the process's syscall channel base, rebound per worker
      // rather than reconstructed from a parent's value.
      //
      // Publishing it anyway is what made `fm_parent_begin_capture` answer
      // EINVAL for every dlopen guest -- the module looked its ordinal up in
      // the KFIG-derived table and found nothing. A capture that refuses is
      // better than one that binds a child's channel base from its parent, so
      // the module's refusal stays; this stops asking it the question.
      const [moduleName = "", name = ""] = key.split("\u0000");
      if (forkRuntimeBindsItself(moduleName, name)) continue;
      for (const { ordinal, space } of declarations) {
        if (space === null) continue;
        if (!values.has(ordinal)) {
          throw new Error(
            `${this.label}: WebAssembly did not read import ordinal ${ordinal} ` +
              `of activation ${activationId}`,
          );
        }
        const value = values.get(ordinal);
        if (space === FORK_IMPORT_SPACE_TABLE) {
          if (!(value instanceof WebAssembly.Table)) {
            throw new Error(
              `${this.label}: import ordinal ${ordinal} of activation ` +
                `${activationId} is not a WebAssembly.Table`,
            );
          }
          this.sink.setImportProvenance(
            space,
            activationId,
            ordinal,
            WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
            this.group(value),
            0n,
          );
          continue;
        }
        let kind: number = WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE;
        let group = 0;
        let bits = 0n;
        if (value instanceof WebAssembly.Global) {
          kind = WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL;
          group = this.group(value);
        } else if (typeof value === "number") {
          kind = WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER;
          bits = f64Bits(value);
        } else if (typeof value === "bigint") {
          kind = WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT;
          bits = BigInt.asUintN(64, value);
        }
        this.sink.setImportProvenance(space, activationId, ordinal, kind, group, bits);
      }
    }
  }

  /** The identity group of one object, assigned on first sight. */
  private group(value: object): number {
    const existing = this.groups.get(value);
    if (existing !== undefined) return existing;
    const assigned = this.nextGroup++;
    this.groups.set(value, assigned);
    return assigned;
  }
}
