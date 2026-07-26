import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "./generated/abi";
import {
  findForkGlobalSnapshot,
  ForkImportedGlobalBindingKind,
  ForkImportedTableBindingKind,
  type ForkGlobalSnapshot,
  type ForkImportedGlobalBinding,
  type ForkImportedGlobalState,
  type ForkImportedTableBinding,
  type ForkImportedTableState,
  type ForkModuleStateArena,
  type ForkModuleStateRecord,
  type ForkTableDirtyTracker,
  importedGlobalBindingsForChild,
  importedTableBindingsForChild,
  readForkImportedGlobals,
  readForkImportedTables,
} from "./fork-module-state";

export type ForkWasmImports = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

interface ParentActivation {
  readonly activationId: number;
  readonly module: WebAssembly.Module;
  readonly globalDescriptors: readonly ForkImportedGlobalState[];
  readonly tableDescriptors: readonly ForkImportedTableState[];
  readonly globalBindings: ReadonlyMap<number, unknown>;
  readonly tableBindings: ReadonlyMap<number, WebAssembly.Table>;
  instance?: WebAssembly.Instance;
}

interface GlobalCoordinate {
  readonly activationId: number;
  readonly ownerId: number;
  readonly imported: boolean;
}

interface TableCoordinate {
  readonly activationId: number;
  readonly ownerId: number;
  readonly imported: boolean;
}

/**
 * Early child-side view of the process reference transaction.
 *
 * This interface is intentionally smaller than the replay transaction. The
 * loader needs only raw immutable import values and their owning activation;
 * ordinary global/table/frame restore still uses the full transaction after
 * every activation is registered.
 */
export interface ForkImportedReferenceProvider {
  ownerActivation(recipeId: number, typeCode: number): number | null;
  /**
   * Complete activation closure needed to materialize a typed recipe.
   *
   * A GC aggregate may be owned by one activation while its constructor or
   * fields depend on codecs/catalogs from several earlier activations. The
   * direct owner alone is therefore insufficient for child instantiation
   * ordering. Scalar/funcref-only providers may omit this and retain the
   * direct-owner behavior.
   */
  activationDependencies?(recipeId: number, typeCode: number): number[];
  materialize(recipeId: number, typeCode: number): unknown;
}

export interface PreparedForkParentActivation {
  readonly imports: ForkWasmImports;
  complete(instance: WebAssembly.Instance): void;
  abort(): void;
}

function assertU32(value: number, context: string, allowZero = true): number {
  if (
    !Number.isInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${context} is not ${allowZero ? "a" : "a nonzero"} u32`);
  }
  return value;
}

function bindingKey(activationId: number, ownerId: number): string {
  return `${activationId}:${ownerId}`;
}

function importKey(module: string, name: string): string {
  return `${module.length}:${module}${name}`;
}

function catalogName(ownerId: number): string {
  return `${WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX}${ownerId}`;
}

function tableCatalogName(ownerId: number): string {
  return `${WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}${ownerId}`;
}

function isReferenceType(typeCode: number): boolean {
  return typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
    || typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
    || typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
    || typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF;
}

interface TableCatalogActivation {
  readonly activationId: number;
  readonly instance: WebAssembly.Instance;
}

function aliasTableDirtyTrackers(
  activations: readonly TableCatalogActivation[],
  trackers: ReadonlyMap<number, ForkTableDirtyTracker>,
  label: string,
): void {
  const identities = new Map<
    WebAssembly.Table,
    Array<{ activationId: number; ownerId: number }>
  >();
  for (const activation of activations) {
    const tracker = trackers.get(activation.activationId);
    if (!tracker) {
      throw new Error(
        `${label}: activation ${activation.activationId} has no table dirty tracker`,
      );
    }
    for (const [name, value] of Object.entries(activation.instance.exports)) {
      if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
      const ownerText = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(ownerText)) {
        throw new Error(`${label}: malformed private table catalog export ${name}`);
      }
      if (!(value instanceof WebAssembly.Table)) {
        throw new Error(`${label}: private table catalog ${name} is not a Table`);
      }
      const ownerId = assertU32(
        Number(ownerText),
        "fork table catalog owner",
        false,
      );
      const coordinates = identities.get(value) ?? [];
      coordinates.push({ activationId: activation.activationId, ownerId });
      identities.set(value, coordinates);
    }
  }
  for (const coordinates of identities.values()) {
    coordinates.sort(
      (left, right) =>
        left.activationId - right.activationId
        || left.ownerId - right.ownerId,
    );
    const source = coordinates[0]!;
    const sourceTracker = trackers.get(source.activationId)!;
    sourceTracker.setStateOwner(source.ownerId, true);
    for (const coordinate of coordinates.slice(1)) {
      const tracker = trackers.get(coordinate.activationId)!;
      tracker.aliasOwner(
        coordinate.ownerId,
        sourceTracker,
        source.ownerId,
      );
      tracker.setStateOwner(coordinate.ownerId, false);
    }
  }
}

function f64Bits(value: number): bigint {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

function numberFromF64Bits(value: bigint): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, value, true);
  return view.getFloat64(0, true);
}

function requireImportNamespace(
  imports: ForkWasmImports,
  moduleName: string,
): Readonly<Record<string, unknown>> {
  const namespace = imports[moduleName];
  if (!namespace || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`fork import object is missing namespace ${JSON.stringify(moduleName)}`);
  }
  return namespace;
}

function validateImportedDescriptors(
  module: WebAssembly.Module,
  globalDescriptors: readonly ForkImportedGlobalState[],
  tableDescriptors: readonly ForkImportedTableState[],
  context: string,
): readonly WebAssembly.ModuleImportDescriptor[] {
  const imports = WebAssembly.Module.imports(module);
  const ordinals = new Set<number>();
  for (const descriptor of globalDescriptors) {
    const declaration = imports[descriptor.importOrdinal];
    if (
      !declaration
      || declaration.kind !== "global"
      || declaration.module !== descriptor.module
      || declaration.name !== descriptor.name
    ) {
      throw new Error(
        `${context}: KFIG owner ${descriptor.ownerId} does not match `
        + `global import ordinal ${descriptor.importOrdinal}`,
      );
    }
    if (ordinals.has(descriptor.importOrdinal)) {
      throw new Error(
        `${context}: duplicate ownership for import ordinal ${descriptor.importOrdinal}`,
      );
    }
    ordinals.add(descriptor.importOrdinal);
  }
  for (const descriptor of tableDescriptors) {
    const declaration = imports[descriptor.importOrdinal];
    if (
      !declaration
      || declaration.kind !== "table"
      || declaration.module !== descriptor.module
      || declaration.name !== descriptor.name
    ) {
      throw new Error(
        `${context}: KFIT owner ${descriptor.ownerId} does not match `
        + `table import ordinal ${descriptor.importOrdinal}`,
      );
    }
    if (ordinals.has(descriptor.importOrdinal)) {
      throw new Error(
        `${context}: duplicate ownership for import ordinal ${descriptor.importOrdinal}`,
      );
    }
    ordinals.add(descriptor.importOrdinal);
  }
  return imports;
}

type OwnedImport =
  | { readonly kind: "global"; readonly descriptor: ForkImportedGlobalState }
  | { readonly kind: "table"; readonly descriptor: ForkImportedTableState };

interface ImportAccess {
  readonly owned?: OwnedImport;
}

function importAccesses(
  module: WebAssembly.Module,
  globalDescriptors: readonly ForkImportedGlobalState[],
  tableDescriptors: readonly ForkImportedTableState[],
  context: string,
): Map<string, ImportAccess[]> {
  const imports = validateImportedDescriptors(
    module,
    globalDescriptors,
    tableDescriptors,
    context,
  );
  const byOrdinal = new Map<number, OwnedImport>();
  for (const descriptor of globalDescriptors) {
    byOrdinal.set(descriptor.importOrdinal, { kind: "global", descriptor });
  }
  for (const descriptor of tableDescriptors) {
    byOrdinal.set(descriptor.importOrdinal, { kind: "table", descriptor });
  }
  const interesting = new Set(
    [...globalDescriptors, ...tableDescriptors]
      .map(({ module, name }) => importKey(module, name)),
  );
  const accesses = new Map<string, ImportAccess[]>();
  imports.forEach((declaration, importOrdinal) => {
    const key = importKey(declaration.module, declaration.name);
    if (!interesting.has(key)) return;
    const values = accesses.get(key) ?? [];
    values.push({ owned: byOrdinal.get(importOrdinal) });
    accesses.set(key, values);
  });
  return accesses;
}

/**
 * Wrap an import object so each global declaration records the exact raw
 * JavaScript value observed by WebAssembly instantiation.
 *
 * Duplicate `(module,name)` declarations are not collapsed. A getter may
 * legally return a different value for each declaration, and Wasm performs
 * each declaration's own type conversion. The child planner installs the same
 * ordered getter sequence.
 */
function recordingImports(
  module: WebAssembly.Module,
  imports: ForkWasmImports,
  globalDescriptors: readonly ForkImportedGlobalState[],
  tableDescriptors: readonly ForkImportedTableState[],
  capturedGlobals: Map<number, unknown>,
  capturedTables: Map<number, unknown>,
): ForkWasmImports {
  const accessPlan = importAccesses(
    module,
    globalDescriptors,
    tableDescriptors,
    "fork parent import capture",
  );
  const byModule = new Map<string, Map<string, ImportAccess[]>>();
  for (const descriptor of [...globalDescriptors, ...tableDescriptors]) {
    let names = byModule.get(descriptor.module);
    if (!names) {
      names = new Map();
      byModule.set(descriptor.module, names);
    }
    names.set(
      descriptor.name,
      accessPlan.get(importKey(descriptor.module, descriptor.name))!,
    );
  }

  const topLevel = new Map<string, object>();
  for (const [moduleName, names] of byModule) {
    const source = requireImportNamespace(imports, moduleName);
    const ordinals = new Map<string, number>();
    topLevel.set(moduleName, new Proxy(source as object, {
      get(target, property, receiver) {
        if (typeof property !== "string") {
          return Reflect.get(target, property, receiver);
        }
        const declarations = names.get(property);
        if (!declarations) return Reflect.get(target, property, receiver);
        const ordinal = ordinals.get(property) ?? 0;
        const access = declarations[ordinal];
        if (!access) {
          throw new Error(
            `WebAssembly read imported global ${JSON.stringify(moduleName)}.`
            + `${JSON.stringify(property)} more than ${declarations.length} time(s)`,
          );
        }
        ordinals.set(property, ordinal + 1);
        const value = Reflect.get(target, property, receiver);
        if (access.owned?.kind === "global") {
          capturedGlobals.set(access.owned.descriptor.ownerId, value);
        } else if (access.owned?.kind === "table") {
          capturedTables.set(access.owned.descriptor.ownerId, value);
        }
        return value;
      },
    }));
  }

  return new Proxy(imports as object, {
    get(target, property, receiver) {
      if (typeof property === "string" && topLevel.has(property)) {
        return topLevel.get(property);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ForkWasmImports;
}

/**
 * Parent-side capture of imported-global identity and raw binding semantics.
 *
 * This owner is process-lifetime state, not per-fork reference state. It holds
 * only already-live activation instances/import values and drops the temporary
 * declaration map after each prepared instantiation completes or aborts.
 */
export class ForkImportedGlobalCapture {
  private readonly activations = new Map<number, ParentActivation>();
  private readonly prepared = new Set<number>();

  constructor(private readonly label: string) {}

  prepareActivation(
    activationId: number,
    module: WebAssembly.Module,
    imports: ForkWasmImports,
  ): PreparedForkParentActivation {
    assertU32(activationId, "fork imported-global activation");
    if (this.activations.has(activationId) || this.prepared.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is already prepared`);
    }
    const globalDescriptors = readForkImportedGlobals(module);
    const tableDescriptors = readForkImportedTables(module);
    const capturedGlobals = new Map<number, unknown>();
    const capturedTables = new Map<number, unknown>();
    this.prepared.add(activationId);
    let finished = false;
    const finish = (): void => {
      if (finished) {
        throw new Error(`${this.label}: activation ${activationId} preparation is finished`);
      }
      finished = true;
      this.prepared.delete(activationId);
    };
    return {
      imports: recordingImports(
        module,
        imports,
        globalDescriptors,
        tableDescriptors,
        capturedGlobals,
        capturedTables,
      ),
      complete: (instance) => {
        finish();
        for (const descriptor of globalDescriptors) {
          if (!capturedGlobals.has(descriptor.ownerId)) {
            throw new Error(
              `${this.label}: WebAssembly did not resolve imported global `
              + `${activationId}:${descriptor.ownerId}`,
            );
          }
        }
        const tables = new Map<number, WebAssembly.Table>();
        for (const descriptor of tableDescriptors) {
          const value = capturedTables.get(descriptor.ownerId);
          if (!(value instanceof WebAssembly.Table)) {
            throw new Error(
              `${this.label}: WebAssembly did not resolve imported table `
              + `${activationId}:${descriptor.ownerId}`,
            );
          }
          tables.set(descriptor.ownerId, value);
        }
        this.activations.set(activationId, {
          activationId,
          module,
          globalDescriptors,
          tableDescriptors,
          globalBindings: capturedGlobals,
          tableBindings: tables,
          instance,
        });
      },
      abort: finish,
    };
  }

  unregisterActivation(activationId: number): void {
    assertU32(activationId, "fork imported-global activation");
    if (!this.activations.delete(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} is not registered`);
    }
  }

  /**
   * Join activation-local dirty journals that name the same live Table.
   *
   * Call this after every activation is registered and before bootstrap/start
   * mutations when possible. Joining is still correct after mutations because
   * `aliasOwner` merges both existing interval sets before sharing the journal.
   */
  bindTableDirtyTrackers(
    trackers: ReadonlyMap<number, ForkTableDirtyTracker>,
  ): void {
    if (this.prepared.size !== 0) {
      throw new Error(
        `${this.label}: cannot bind table journals with `
        + `${this.prepared.size} incomplete activation(s)`,
      );
    }
    aliasTableDirtyTrackers(
      this.orderedActivations().map(({ activationId, instance }) => ({
        activationId,
        instance: instance!,
      })),
      trackers,
      this.label,
    );
  }

  appendTo(arena: ForkModuleStateArena): readonly ForkImportedGlobalBinding[] {
    if (this.prepared.size !== 0) {
      throw new Error(
        `${this.label}: cannot snapshot with ${this.prepared.size} incomplete activation(s)`,
      );
    }
    const records = arena.recordsForCapture();
    const globalCoordinates = this.globalCoordinates();
    const tableCoordinates = this.tableCoordinates();
    const bindings: ForkImportedGlobalBinding[] = [];
    const tableBindings: ForkImportedTableBinding[] = [];
    for (const activation of this.orderedActivations()) {
      for (const descriptor of activation.globalDescriptors) {
        const snapshot = findForkGlobalSnapshot(
          records,
          activation.activationId,
          descriptor.ownerId,
        );
        if (snapshot.typeCode !== descriptor.typeCode) {
          throw new Error(
            `${this.label}: imported global ${activation.activationId}:`
            + `${descriptor.ownerId} snapshot type does not match KFIG`,
          );
        }
        const value = activation.globalBindings.get(descriptor.ownerId)!;
        bindings.push(this.captureBinding(
          activation.activationId,
          descriptor,
          snapshot,
          value,
          globalCoordinates,
        ));
      }
      for (const descriptor of activation.tableDescriptors) {
        tableBindings.push(this.captureTableBinding(
          activation.activationId,
          descriptor,
          activation.tableBindings.get(descriptor.ownerId)!,
          tableCoordinates,
        ));
      }
    }
    bindings.sort(
      (left, right) =>
        left.consumerActivation - right.consumerActivation
        || left.consumerOwner - right.consumerOwner,
    );
    tableBindings.sort(
      (left, right) =>
        left.consumerActivation - right.consumerActivation
        || left.consumerOwner - right.consumerOwner,
    );
    arena.appendImportedGlobalBindings(bindings);
    arena.appendImportedTableBindings(tableBindings);
    return bindings;
  }

  clear(): void {
    this.activations.clear();
    this.prepared.clear();
  }

  private orderedActivations(): ParentActivation[] {
    return [...this.activations.values()].sort(
      (left, right) => left.activationId - right.activationId,
    );
  }

  private globalCoordinates(): WeakMap<WebAssembly.Global, GlobalCoordinate[]> {
    const coordinates = new WeakMap<WebAssembly.Global, GlobalCoordinate[]>();
    for (const activation of this.orderedActivations()) {
      const importedOwners = new Set(
        activation.globalDescriptors.map(({ ownerId }) => ownerId),
      );
      for (const [name, value] of Object.entries(activation.instance!.exports)) {
        if (!name.startsWith(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX)) continue;
        const ownerText = name.slice(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX.length);
        if (!/^[1-9][0-9]*$/.test(ownerText)) {
          throw new Error(`${this.label}: malformed private global catalog export ${name}`);
        }
        const ownerId = Number(ownerText);
        assertU32(ownerId, "fork global catalog owner", false);
        if (!(value instanceof WebAssembly.Global)) {
          throw new Error(`${this.label}: private global catalog ${name} is not a Global`);
        }
        const entries = coordinates.get(value) ?? [];
        entries.push({
          activationId: activation.activationId,
          ownerId,
          imported: importedOwners.has(ownerId),
        });
        coordinates.set(value, entries);
      }
    }
    return coordinates;
  }

  private tableCoordinates(): WeakMap<WebAssembly.Table, TableCoordinate[]> {
    const coordinates = new WeakMap<WebAssembly.Table, TableCoordinate[]>();
    for (const activation of this.orderedActivations()) {
      const importedOwners = new Set(
        activation.tableDescriptors.map(({ ownerId }) => ownerId),
      );
      for (const [name, value] of Object.entries(activation.instance!.exports)) {
        if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
        const ownerText = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
        if (!/^[1-9][0-9]*$/.test(ownerText)) {
          throw new Error(`${this.label}: malformed private table catalog export ${name}`);
        }
        const ownerId = Number(ownerText);
        assertU32(ownerId, "fork table catalog owner", false);
        if (!(value instanceof WebAssembly.Table)) {
          throw new Error(`${this.label}: private table catalog ${name} is not a Table`);
        }
        const entries = coordinates.get(value) ?? [];
        entries.push({
          activationId: activation.activationId,
          ownerId,
          imported: importedOwners.has(ownerId),
        });
        coordinates.set(value, entries);
      }
    }
    return coordinates;
  }

  private captureBinding(
    activationId: number,
    descriptor: ForkImportedGlobalState,
    snapshot: ForkGlobalSnapshot,
    value: unknown,
    coordinates: WeakMap<WebAssembly.Global, GlobalCoordinate[]>,
  ): ForkImportedGlobalBinding {
    const base = {
      consumerActivation: activationId,
      consumerOwner: descriptor.ownerId,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      recipeId: 0,
      rawBits: 0n,
      mutable: descriptor.mutable,
      shared: descriptor.shared,
      typeCode: descriptor.typeCode,
    };
    if (value instanceof WebAssembly.Global) {
      const candidates = (coordinates.get(value) ?? [])
        .filter((coordinate) => !coordinate.imported)
        .sort(
          (left, right) =>
            left.activationId - right.activationId
            || left.ownerId - right.ownerId,
        );
      const provider = candidates[0];
      if (provider) {
        return {
          ...base,
          kind: ForkImportedGlobalBindingKind.ActivationGlobal,
          sourceActivation: provider.activationId,
          sourceOwner: provider.ownerId,
        };
      }
      return {
        ...base,
        // The final child import builder owns process cells such as GOT,
        // stack-pointer, and dylink base globals. Re-resolving the exact
        // declaration preserves its identity without copying a JS handle.
        kind: ForkImportedGlobalBindingKind.BaseImport,
      };
    }

    if (isReferenceType(descriptor.typeCode)) {
      if (snapshot.recipeId === undefined) {
        throw new Error(
          `${this.label}: reference import ${activationId}:${descriptor.ownerId} `
          + "has no recipe id",
        );
      }
      if (
        descriptor.typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
        && snapshot.recipeId !== 0
      ) {
        // WHY: JavaScript cannot read or carry a non-null exnref. A legitimate
        // non-null import is necessarily a WebAssembly.Global carrier and was
        // handled above as ActivationGlobal/BaseImport. Emitting RawReference
        // here would manufacture a child transport that the embedding API
        // cannot represent.
        throw new Error(
          `${this.label}: non-null exnref import ${activationId}:`
          + `${descriptor.ownerId} has no WebAssembly.Global carrier`,
        );
      }
      return {
        ...base,
        kind: ForkImportedGlobalBindingKind.RawReference,
        recipeId: snapshot.recipeId,
      };
    }
    if (typeof value === "number") {
      return {
        ...base,
        kind: ForkImportedGlobalBindingKind.RawNumber,
        rawBits: f64Bits(value),
      };
    }
    if (typeof value === "bigint") {
      return {
        ...base,
        kind: ForkImportedGlobalBindingKind.RawBigInt,
        rawBits: BigInt.asUintN(64, value),
      };
    }
    return {
      ...base,
      kind: ForkImportedGlobalBindingKind.BaseImport,
    };
  }

  private captureTableBinding(
    activationId: number,
    descriptor: ForkImportedTableState,
    value: WebAssembly.Table,
    coordinates: WeakMap<WebAssembly.Table, TableCoordinate[]>,
  ): ForkImportedTableBinding {
    const candidates = (coordinates.get(value) ?? [])
      .filter((coordinate) => !coordinate.imported)
      .sort(
        (left, right) =>
          left.activationId - right.activationId
          || left.ownerId - right.ownerId,
      );
    const provider = candidates[0];
    if (provider) {
      return {
        consumerActivation: activationId,
        consumerOwner: descriptor.ownerId,
        sourceActivation: provider.activationId,
        sourceOwner: provider.ownerId,
        reserved: 0,
        kind: ForkImportedTableBindingKind.ActivationTable,
      };
    }
    return {
      consumerActivation: activationId,
      consumerOwner: descriptor.ownerId,
      sourceActivation: 0,
      sourceOwner: 0,
      reserved: 0,
      // Process tables are reconstructed by the same main/dylink import
      // builder that created them in the parent. The planner deliberately
      // leaves this declaration's lazy getter in control.
      kind: ForkImportedTableBindingKind.BaseImport,
    };
  }
}

interface ChildActivation {
  readonly activationId: number;
  readonly module: WebAssembly.Module;
  readonly globalDescriptors: readonly ForkImportedGlobalState[];
  readonly tableDescriptors: readonly ForkImportedTableState[];
  readonly globalBindings: readonly ForkImportedGlobalBinding[];
  readonly tableBindings: readonly ForkImportedTableBinding[];
}

/**
 * Fresh-child instantiation planner for imported globals.
 *
 * Provider activations are topologically ordered before consumers. Mutable
 * Global cells may still contain their deterministic baseline while consumers
 * bind them; KFMS restore updates that one shared cell after all activations
 * exist. Immutable cells are already final by definition, so const
 * initializers and direct re-exports observe the exact provider identity at
 * instantiation time.
 */
export class ForkImportedGlobalPlanner {
  private readonly activations = new Map<number, ChildActivation>();
  private readonly instances = new Map<number, WebAssembly.Instance>();
  private readonly globalBindingsByConsumer =
    new Map<string, ForkImportedGlobalBinding>();
  private readonly tableBindingsByConsumer =
    new Map<string, ForkImportedTableBinding>();

  constructor(
    records: readonly ForkModuleStateRecord[],
    modules: ReadonlyMap<number, WebAssembly.Module>,
    private readonly references: ForkImportedReferenceProvider,
    private readonly label: string,
  ) {
    const globalBindings = importedGlobalBindingsForChild(records);
    const tableBindings = importedTableBindingsForChild(records);
    for (const binding of globalBindings) {
      this.globalBindingsByConsumer.set(
        bindingKey(binding.consumerActivation, binding.consumerOwner),
        binding,
      );
    }
    for (const binding of tableBindings) {
      this.tableBindingsByConsumer.set(
        bindingKey(binding.consumerActivation, binding.consumerOwner),
        binding,
      );
    }
    for (const [activationId, module] of [...modules].sort(
      ([left], [right]) => left - right,
    )) {
      assertU32(activationId, "fork imported-global activation");
      const globalDescriptors = readForkImportedGlobals(module);
      const tableDescriptors = readForkImportedTables(module);
      const activationGlobalBindings = globalDescriptors.map((descriptor) => {
        const binding = this.globalBindingsByConsumer.get(
          bindingKey(activationId, descriptor.ownerId),
        );
        if (!binding) {
          throw new Error(
            `${this.label}: missing imported-global binding `
            + `${activationId}:${descriptor.ownerId}`,
          );
        }
        if (
          binding.typeCode !== descriptor.typeCode
          || binding.mutable !== descriptor.mutable
          || binding.shared !== descriptor.shared
        ) {
          throw new Error(
            `${this.label}: imported-global binding ${activationId}:`
            + `${descriptor.ownerId} does not match KFIG`,
          );
        }
        if (
          binding.kind === ForkImportedGlobalBindingKind.RawReference
          && binding.typeCode === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
          && binding.recipeId !== 0
        ) {
          throw new Error(
            `${this.label}: imported exnref binding ${activationId}:`
            + `${descriptor.ownerId} has impossible raw non-null provenance`,
          );
        }
        return binding;
      });
      const activationTableBindings = tableDescriptors.map((descriptor) => {
        const binding = this.tableBindingsByConsumer.get(
          bindingKey(activationId, descriptor.ownerId),
        );
        if (!binding) {
          throw new Error(
            `${this.label}: missing imported-table binding `
            + `${activationId}:${descriptor.ownerId}`,
          );
        }
        return binding;
      });
      this.activations.set(activationId, {
        activationId,
        module,
        globalDescriptors,
        tableDescriptors,
        globalBindings: activationGlobalBindings,
        tableBindings: activationTableBindings,
      });
    }
    if (
      globalBindings.length
      !== [...this.activations.values()]
        .reduce((count, activation) => count + activation.globalBindings.length, 0)
    ) {
      throw new Error(`${this.label}: imported-global bindings name unknown declarations`);
    }
    if (
      tableBindings.length
      !== [...this.activations.values()]
        .reduce((count, activation) => count + activation.tableBindings.length, 0)
    ) {
      throw new Error(`${this.label}: imported-table bindings name unknown declarations`);
    }
  }

  instantiationOrder(): number[] {
    const ids = [...this.activations.keys()].sort((left, right) => left - right);
    const dependencies = new Map<number, Set<number>>(
      ids.map((id) => [id, new Set(this.dependenciesFor(id))]),
    );
    const order: number[] = [];
    const remaining = new Set(ids);
    while (remaining.size !== 0) {
      const ready = [...remaining]
        .filter((id) =>
          [...dependencies.get(id)!].every(
            (dependency) => !remaining.has(dependency),
          ))
        .sort((left, right) => left - right);
      if (ready.length === 0) {
        const cycle = [...remaining].sort((left, right) => left - right);
        throw new Error(
          `${this.label}: imported-global provider cycle among activations `
          + cycle.join(", "),
        );
      }
      for (const id of ready) {
        remaining.delete(id);
        order.push(id);
      }
    }
    return order;
  }

  dependenciesFor(activationId: number): number[] {
    const activation = this.requireActivation(activationId);
    const dependencies = new Set<number>();
    for (const binding of activation.globalBindings) {
      let dependency: number | null = null;
      switch (binding.kind) {
        case ForkImportedGlobalBindingKind.ActivationGlobal:
          dependency = binding.sourceActivation;
          break;
        case ForkImportedGlobalBindingKind.RawReference: {
          const closure = this.references.activationDependencies?.(
            binding.recipeId,
            binding.typeCode,
          );
          if (closure) {
            for (const activationDependency of closure) {
              if (activationDependency === activationId) continue;
              if (!this.activations.has(activationDependency)) {
                throw new Error(
                  `${this.label}: activation ${activationId} depends on missing `
                  + `provider activation ${activationDependency}`,
                );
              }
              dependencies.add(activationDependency);
            }
            break;
          }
          dependency = this.references.ownerActivation(
            binding.recipeId,
            binding.typeCode,
          );
          break;
        }
        case ForkImportedGlobalBindingKind.BaseImport:
        case ForkImportedGlobalBindingKind.RawNumber:
        case ForkImportedGlobalBindingKind.RawBigInt:
          break;
      }
      if (dependency === null || dependency === activationId) continue;
      if (!this.activations.has(dependency)) {
        throw new Error(
          `${this.label}: activation ${activationId} depends on missing `
          + `provider activation ${dependency}`,
        );
      }
      dependencies.add(dependency);
    }
    for (const binding of activation.tableBindings) {
      let dependency: number | null = null;
      switch (binding.kind) {
        case ForkImportedTableBindingKind.ActivationTable:
          dependency = binding.sourceActivation;
          break;
        case ForkImportedTableBindingKind.BaseImport:
          break;
      }
      if (dependency === null || dependency === activationId) continue;
      if (!this.activations.has(dependency)) {
        throw new Error(
          `${this.label}: activation ${activationId} depends on missing `
          + `provider activation ${dependency}`,
        );
      }
      dependencies.add(dependency);
    }
    return [...dependencies].sort((left, right) => left - right);
  }

  importsForActivation(
    activationId: number,
    baseImports: ForkWasmImports,
  ): ForkWasmImports {
    const activation = this.requireActivation(activationId);
    const resolvedByOrdinal = new Map<
      number,
      { override: boolean; value?: unknown }
    >();
    activation.globalDescriptors.forEach((descriptor, index) => {
      const binding = activation.globalBindings[index]!;
      resolvedByOrdinal.set(
        descriptor.importOrdinal,
        binding.kind === ForkImportedGlobalBindingKind.BaseImport
          ? { override: false }
          : { override: true, value: this.resolveGlobal(binding) },
      );
    });
    activation.tableDescriptors.forEach((descriptor, index) => {
      const binding = activation.tableBindings[index]!;
      resolvedByOrdinal.set(
        descriptor.importOrdinal,
        binding.kind === ForkImportedTableBindingKind.BaseImport
          ? { override: false }
          : { override: true, value: this.resolveTable(binding) },
      );
    });
    const accessPlan = importAccesses(
      activation.module,
      activation.globalDescriptors,
      activation.tableDescriptors,
      `${this.label}: activation ${activationId}`,
    );
    const byModule = new Map<
      string,
      Map<string, Array<{ override: boolean; value?: unknown }>>
    >();
    for (
      const descriptor of [
        ...activation.globalDescriptors,
        ...activation.tableDescriptors,
      ]
    ) {
      let names = byModule.get(descriptor.module);
      if (!names) {
        names = new Map();
        byModule.set(descriptor.module, names);
      }
      names.set(
        descriptor.name,
        accessPlan.get(importKey(descriptor.module, descriptor.name))!.map(
          (access) => access.owned
            ? resolvedByOrdinal.get(access.owned.descriptor.importOrdinal)!
            : { override: false },
        ),
      );
    }

    const namespaces = new Map<string, object>();
    for (const [moduleName, names] of byModule) {
      const source = baseImports[moduleName] ?? {};
      const ordinals = new Map<string, number>();
      namespaces.set(moduleName, new Proxy(source as object, {
        get(target, property, receiver) {
          if (typeof property !== "string") {
            return Reflect.get(target, property, receiver);
          }
          const accesses = names.get(property);
          if (!accesses) return Reflect.get(target, property, receiver);
          const ordinal = ordinals.get(property) ?? 0;
          const access = accesses[ordinal];
          if (!access) {
            throw new Error(
              `WebAssembly read reconstructed global ${JSON.stringify(moduleName)}.`
              + `${JSON.stringify(property)} more than ${accesses.length} time(s)`,
            );
          }
          ordinals.set(property, ordinal + 1);
          return access.override
            ? access.value
            : Reflect.get(target, property, receiver);
        },
      }));
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
    this.requireActivation(activationId);
    if (this.instances.has(activationId)) {
      throw new Error(`${this.label}: activation ${activationId} was instantiated twice`);
    }
    this.instances.set(activationId, instance);
  }

  /**
   * Join child journals before KFMS restore marks replayed sparse pages.
   *
   * All instances are required so aliases are derived from actual provider
   * identity instead of guessed from import names.
   */
  bindTableDirtyTrackers(
    trackers: ReadonlyMap<number, ForkTableDirtyTracker>,
  ): void {
    if (this.instances.size !== this.activations.size) {
      throw new Error(
        `${this.label}: cannot bind table journals before all `
        + `${this.activations.size} activation(s) are instantiated`,
      );
    }
    aliasTableDirtyTrackers(
      [...this.instances]
        .sort(([left], [right]) => left - right)
        .map(([activationId, instance]) => ({ activationId, instance })),
      trackers,
      this.label,
    );
  }

  clear(): void {
    this.instances.clear();
  }

  private resolveGlobal(binding: ForkImportedGlobalBinding): unknown {
    switch (binding.kind) {
      case ForkImportedGlobalBindingKind.RawNumber:
        return numberFromF64Bits(binding.rawBits);
      case ForkImportedGlobalBindingKind.RawBigInt:
        return BigInt.asIntN(64, binding.rawBits);
      case ForkImportedGlobalBindingKind.RawReference:
        return this.references.materialize(binding.recipeId, binding.typeCode);
      case ForkImportedGlobalBindingKind.ActivationGlobal: {
        const provider = this.instances.get(binding.sourceActivation);
        if (!provider) {
          throw new Error(
            `${this.label}: provider activation ${binding.sourceActivation} `
            + "is not instantiated",
          );
        }
        const value = provider.exports[catalogName(binding.sourceOwner)];
        if (!(value instanceof WebAssembly.Global)) {
          throw new Error(
            `${this.label}: provider global ${binding.sourceActivation}:`
            + `${binding.sourceOwner} is missing`,
          );
        }
        return value;
      }
      case ForkImportedGlobalBindingKind.BaseImport:
        throw new Error(`${this.label}: base import cannot be eagerly resolved`);
    }
  }

  private resolveTable(binding: ForkImportedTableBinding): WebAssembly.Table {
    switch (binding.kind) {
      case ForkImportedTableBindingKind.ActivationTable: {
        const provider = this.instances.get(binding.sourceActivation);
        if (!provider) {
          throw new Error(
            `${this.label}: provider activation ${binding.sourceActivation} `
            + "is not instantiated",
          );
        }
        const value = provider.exports[tableCatalogName(binding.sourceOwner)];
        if (!(value instanceof WebAssembly.Table)) {
          throw new Error(
            `${this.label}: provider table ${binding.sourceActivation}:`
            + `${binding.sourceOwner} is missing`,
          );
        }
        return value;
      }
      case ForkImportedTableBindingKind.BaseImport:
        throw new Error(`${this.label}: base table import cannot be eagerly resolved`);
    }
  }

  private requireActivation(activationId: number): ChildActivation {
    assertU32(activationId, "fork imported-global activation");
    const activation = this.activations.get(activationId);
    if (!activation) {
      throw new Error(`${this.label}: activation ${activationId} is not declared`);
    }
    return activation;
  }
}
