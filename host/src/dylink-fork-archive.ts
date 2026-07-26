import type {
  DylinkForkLibraryState,
  DylinkForkState,
  DylinkForkTransactionState,
  DylinkInitializationStage,
} from "./dylink";
import { computeForkModuleTemplateIdSync } from "./fork-module-state";

const ARCHIVE_MAGIC = 0x414c_464b; // "KFLA" in little-endian memory.
const ARCHIVE_VERSION = 4;
const ARCHIVE_HEADER_SIZE = 104;
const MODULE_MAGIC = 0x4d4c_464b; // "KFLM" in little-endian memory.
const MODULE_VERSION = 5;
const MODULE_HEADER_SIZE = 136;
const MODULE_DIGEST_OFFSET = 72;
const MODULE_DIGEST_SIZE = 32;
const MODULE_ALLOCATION_SIZE = 32;
const MODULE_FLAG_INITIALIZING = 1;
const MODULE_FLAG_GLOBAL = 1 << 1;
const MODULE_FLAG_COMMITTED_GLOBAL_ROOT = 1 << 2;
const MODULE_FLAG_KNOWN_MASK =
  MODULE_FLAG_INITIALIZING
  | MODULE_FLAG_GLOBAL
  | MODULE_FLAG_COMMITTED_GLOBAL_ROOT;
const TRANSACTION_MAGIC = 0x544c_464b; // "KFLT" in little-endian memory.
const TRANSACTION_VERSION = 2;
const TRANSACTION_HEADER_SIZE = 80;
const TRANSACTION_DIGEST_OFFSET = 40;
const TRANSACTION_FLAG_GLOBAL = 1;
const TABLE_PATCH_MAGIC = 0x504a_464b; // "KFJP" in little-endian memory.
const TABLE_PATCH_VERSION = 1;
const TABLE_PATCH_HEADER_SIZE = 64;
const TABLE_PATCH_RUN_SIZE = 24;
const MAX_TABLE_PATCH_RECORDS = 256;
const MAX_TABLE_PATCH_BYTES = 1024 * 1024;
const FIRST_DYLINK_HANDLE = 2;
const EXHAUSTED_DYLINK_HANDLE = 0x1_0000_0000;
const MAX_EXACT_GENERATION = Number.MAX_SAFE_INTEGER;

export interface DylinkForkArchiveSnapshot extends DylinkForkState {
  /**
   * Monotonic publication generation.
   *
   * Zero means that no archive has ever been published. A Worker may compare
   * this scalar before parsing module records; a changed value requires a
   * complete validated read before it can execute a table function installed
   * by dlopen.
   */
  readonly generation: number;
  /** Sealed table-only KFMS arena, or zero before the first mutation. */
  readonly tableStateRoot: number;
  /** Generation represented by `tableStateRoot`, or zero when it is absent. */
  readonly tableCheckpointGeneration: number;
  /** Ordered funcref patches published after the current checkpoint. */
  readonly tablePatches: readonly DylinkForkTablePatch[];
}

export interface DylinkForkTablePatchRun {
  readonly length: number;
  /** Null has no function coordinate. */
  readonly function:
    | null
    | Readonly<{
        activationId: number;
        ordinal: number;
      }>;
}

export interface DylinkForkTablePatch {
  /** Assigned atomically by the archive at publication. */
  readonly generation?: number;
  readonly activationId: number;
  readonly ownerId: number;
  readonly start: number;
  readonly tableLength: number;
  readonly runs: readonly DylinkForkTablePatchRun[];
}

export interface DylinkForkArchiveAllocation {
  readonly address: number;
  readonly size: number;
}

export type DylinkForkArchiveAllocate = (
  size: number,
) => DylinkForkArchiveAllocation;

export type DylinkForkArchiveDeallocate = (
  allocation: DylinkForkArchiveAllocation,
) => void;

export interface DylinkForkGenerationFence {
  read(): number;
  write(generation: number): void;
}

export interface DylinkForkTablePublication {
  readonly snapshot: DylinkForkArchiveSnapshot;
  readonly previousTableStateRoot: number;
}

export interface DylinkForkTablePatchPublication {
  readonly snapshot: DylinkForkArchiveSnapshot;
}

/**
 * Per-Worker generation gate for deterministic module/table recipes.
 *
 * The callback instantiates missing side modules into that Worker's own table
 * and activation catalog. No function object crosses the Worker boundary.
 */
export class DylinkForkTableReplica {
  private appliedGeneration = 0;

  constructor(
    private readonly archive: DylinkForkArchive,
    private readonly materialize: (
      snapshot: DylinkForkArchiveSnapshot,
      previousGeneration: number,
    ) => void,
    private readonly label: string,
  ) {}

  generation(): number {
    return this.appliedGeneration;
  }

  /**
   * Advance the Worker that encoded the just-published state without
   * reconstructing typed references back into their source Table.
   */
  adoptPublishedGeneration(generation: number): void {
    if (
      !Number.isSafeInteger(generation)
      || generation < this.appliedGeneration
    ) {
      throw new RangeError(
        `${this.label}: cannot adopt dylink generation ${String(generation)}`,
      );
    }
    this.appliedGeneration = generation;
  }

  reconcile(): boolean {
    const published = this.archive.generation();
    if (published === this.appliedGeneration) return false;
    if (published < this.appliedGeneration) {
      throw new Error(
        `${this.label}: dylink archive generation moved backward from `
        + `${this.appliedGeneration} to ${published}`,
      );
    }
    const snapshot = this.archive.read();
    if (snapshot.generation !== published) {
      throw new Error(
        `${this.label}: dylink archive changed while its reader lock was held`,
      );
    }
    this.materialize(snapshot, this.appliedGeneration);
    // Publish locally only after every fresh function object is installed.
    this.appliedGeneration = snapshot.generation;
    return true;
  }
}

interface IndexedModule {
  readonly allocation: DylinkForkArchiveAllocation;
  readonly state: DylinkForkLibraryState;
}

interface IndexedTablePatch {
  readonly allocation: DylinkForkArchiveAllocation;
  readonly patch: DylinkForkTablePatch & { readonly generation: number };
}

interface IndexedTransaction {
  readonly allocation: DylinkForkArchiveAllocation;
  readonly state: DylinkForkTransactionState;
}

function align8(value: number): number {
  const aligned = Math.ceil(value / 8) * 8;
  if (!Number.isSafeInteger(aligned)) {
    throw new RangeError("dylink fork archive size exceeds exact host integers");
  }
  return aligned;
}

function canonicalProviderDependencies(
  state: DylinkForkLibraryState,
): string[] {
  const dependencies = [...(state.providerDependencies ?? [])].sort();
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    if (
      typeof dependency !== "string"
      || dependency.length === 0
      || dependency === state.name
      || seen.has(dependency)
    ) {
      throw new Error(
        `${state.name}: invalid or duplicate runtime provider ${String(dependency)}`,
      );
    }
    seen.add(dependency);
  }
  return dependencies;
}

function canonicalMemoryAllocations(
  state: DylinkForkLibraryState,
): NonNullable<DylinkForkLibraryState["allocations"]>[number][] {
  const allocations = [...(state.allocations ?? [])]
    .map((allocation) => ({ ...allocation }))
    .sort(
      (left, right) =>
        left.mappingAddress - right.mappingAddress
        || left.address - right.address,
    );
  let previousMappingEnd = 0;
  for (const [index, allocation] of allocations.entries()) {
    checkedAddress(
      allocation.address,
      `${state.name}: allocation ${index} address`,
    );
    checkedAddress(
      allocation.size,
      `${state.name}: allocation ${index} size`,
    );
    checkedAddress(
      allocation.mappingAddress,
      `${state.name}: allocation ${index} mapping address`,
    );
    checkedAddress(
      allocation.mappingSize,
      `${state.name}: allocation ${index} mapping size`,
    );
    const logicalEnd = allocation.address + allocation.size;
    const mappingEnd = allocation.mappingAddress + allocation.mappingSize;
    if (
      !Number.isSafeInteger(logicalEnd)
      || !Number.isSafeInteger(mappingEnd)
      || allocation.address < allocation.mappingAddress
      || logicalEnd > mappingEnd
    ) {
      throw new RangeError(
        `${state.name}: allocation ${index} escapes its process mapping`,
      );
    }
    if (allocation.mappingAddress < previousMappingEnd) {
      throw new Error(`${state.name}: process allocation mappings overlap`);
    }
    previousMappingEnd = mappingEnd;
  }
  return allocations;
}

function encodeProviderDependencies(
  state: DylinkForkLibraryState,
): Readonly<{
  bytes: Uint8Array;
  count: number;
}> {
  const encoded = canonicalProviderDependencies(state).map((dependency) => {
    const bytes = new TextEncoder().encode(dependency);
    checkedU32(bytes.length, `${state.name}: runtime provider name length`);
    return bytes;
  });
  const size = encoded.reduce((total, bytes) => {
    const next = total + 4 + bytes.length;
    if (!Number.isSafeInteger(next) || next > 0xffff_ffff) {
      throw new RangeError(
        `${state.name}: runtime provider archive is too large`,
      );
    }
    return next;
  }, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  for (const name of encoded) {
    view.setUint32(cursor, name.length, true);
    cursor += 4;
    bytes.set(name, cursor);
    cursor += name.length;
  }
  return { bytes, count: encoded.length };
}

function decodeProviderDependencies(
  bytes: Uint8Array,
  count: number,
  context: string,
): string[] {
  checkedU32(count, `${context} runtime provider count`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dependencies: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor > bytes.length - 4) {
      throw new Error(`${context}: truncated runtime provider metadata`);
    }
    const length = view.getUint32(cursor, true);
    cursor += 4;
    if (length === 0 || cursor > bytes.length - length) {
      throw new Error(`${context}: invalid runtime provider name length`);
    }
    let dependency: string;
    try {
      dependency = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(cursor, cursor + length),
      );
    } catch {
      throw new Error(`${context}: invalid UTF-8 runtime provider name`);
    }
    if (
      dependencies.length > 0
      && dependencies[dependencies.length - 1]! >= dependency
    ) {
      throw new Error(`${context}: noncanonical runtime provider ordering`);
    }
    dependencies.push(dependency);
    cursor += length;
  }
  if (cursor !== bytes.length) {
    throw new Error(`${context}: noncanonical runtime provider metadata`);
  }
  return dependencies;
}

function equalBytes(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function checkedU32(value: number, context: string, allowZero = true): number {
  if (
    !Number.isInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${context} is not ${allowZero ? "a" : "a nonzero"} u32`);
  }
  return value;
}

function checkedAddress(value: number, context: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${context} is not an exact positive address`);
  }
  return value;
}

function checkedExactNonnegative(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${context} is not an exact non-negative integer`);
  }
  return value;
}

function checkedNextHandle(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < FIRST_DYLINK_HANDLE
    || value > EXHAUSTED_DYLINK_HANDLE
  ) {
    throw new RangeError(`dylink fork archive next handle ${String(value)} is invalid`);
  }
  return value;
}

function initializationStageCode(stage: DylinkInitializationStage): number {
  switch (stage) {
    case "bootstrap": return 1;
    case "relocations": return 2;
    case "constructors": return 3;
  }
}

function decodeInitializationStage(
  code: number,
  context: string,
): DylinkInitializationStage {
  switch (code) {
    case 1: return "bootstrap";
    case 2: return "relocations";
    case 3: return "constructors";
    default: throw new Error(`${context}: invalid initialization stage ${code}`);
  }
}

/**
 * Versioned, bounded-by-live-closure dylink state copied through process memory.
 *
 * The JavaScript object graph is only an index/cache. Durable state is the
 * header and module records in linear memory, which a pthread or fresh process
 * worker can validate and adopt independently.
 */
export class DylinkForkArchive {
  private headerAddress = 0;
  private indexed = false;
  private modules = new Map<string, IndexedModule>();
  private transactions = new Map<number, IndexedTransaction>();
  private tablePatchRecords: IndexedTablePatch[] = [];
  private state: DylinkForkArchiveSnapshot = {
    generation: 0,
    tableStateRoot: 0,
    tableCheckpointGeneration: 0,
    tablePatches: [],
    nextHandle: FIRST_DYLINK_HANDLE,
    libraries: [],
    transactions: [],
  };

  constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly ptrWidth: 4 | 8,
    private readonly readHead: () => number,
    private readonly writeHead: (address: number) => void,
    private readonly allocate: DylinkForkArchiveAllocate,
    private readonly deallocate: DylinkForkArchiveDeallocate,
    private readonly label: string,
    private readonly generationFence?: DylinkForkGenerationFence,
  ) {
    if (ptrWidth !== 4 && ptrWidth !== 8) {
      throw new RangeError(`${label}: invalid archive pointer width ${ptrWidth}`);
    }
  }

  /**
   * Return the current publication generation without walking module records.
   *
   * Callers still hold the process archive reader lock while acting on the
   * result. The scalar is a fast-path hint, not permission to consume a
   * concurrently changing archive.
   */
  generation(): number {
    const head = this.readHead();
    const fenced = this.generationFence?.read();
    if (head === 0) {
      if (fenced !== undefined && fenced !== 0) {
        throw new Error(`${this.label}: published generation has no archive header`);
      }
      return 0;
    }
    this.checkedRange(head, ARCHIVE_HEADER_SIZE, "archive header");
    return fenced ?? this.readGeneration(head);
  }

  /** Validate and return an owned snapshot of the copied archive. */
  read(): DylinkForkArchiveSnapshot {
    this.refreshIndex();
    return this.copyState(this.state);
  }

  /**
   * Publish the exact compact live linker state.
   *
   * Callers serialize this operation with process dlopen/fork arbitration.
   * New records are fully initialized before the header points at them; stale
   * records become unreachable before their mappings are released.
   */
  sync(nextState: DylinkForkState): DylinkForkArchiveSnapshot {
    const owned = this.validateState(nextState);
    this.refreshIndex();
    this.ensureHeader(owned.nextHandle);
    const generation = this.nextGeneration(this.state.generation);

    const target: IndexedModule[] = [];
    const targetNames = new Set<string>();
    const replaced: IndexedModule[] = [];
    for (const library of owned.libraries) {
      targetNames.add(library.name);
      const current = this.modules.get(library.name);
      if (current) {
        this.requireImmutableMatch(current.state, library);
        const currentProviders =
          canonicalProviderDependencies(current.state);
        const nextProviders = canonicalProviderDependencies(library);
        if (
          currentProviders.length === nextProviders.length
          && currentProviders.every(
            (dependency, index) => dependency === nextProviders[index],
          )
        ) {
          this.writeMutableState(current.allocation.address, library);
          target.push({
            allocation: current.allocation,
            state: library,
          });
        } else {
          // Constructor dlsym can add a runtime-provider edge between archive
          // generations. Publish a complete replacement record; never resize a
          // reachable record beneath pthread readers.
          target.push(this.allocateModule(library));
          replaced.push(current);
        }
      } else {
        target.push(this.allocateModule(library));
      }
    }

    for (let index = 0; index < target.length; index++) {
      this.writeU64(
        target[index]!.allocation.address + 8,
        target[index + 1]?.allocation.address ?? 0,
      );
    }

    const transactionTarget: IndexedTransaction[] = [];
    const transactionTokens = new Set<number>();
    for (const transaction of owned.transactions ?? []) {
      transactionTokens.add(transaction.token);
      const current = this.transactions.get(transaction.token);
      if (current) {
          if (
            current.state.name !== transaction.name
            || current.state.globalVisibility !== transaction.globalVisibility
            || !equalBytes(current.state.moduleBytes, transaction.moduleBytes)
        ) {
          throw new Error(
            `${this.label}: staged transaction ${transaction.token} changed identity`,
          );
        }
        transactionTarget.push({
          allocation: current.allocation,
          state: transaction,
        });
      } else {
        transactionTarget.push(this.allocateTransaction(transaction));
      }
    }
    for (let index = 0; index < transactionTarget.length; index++) {
      this.writeU64(
        transactionTarget[index]!.allocation.address + 8,
        transactionTarget[index + 1]?.allocation.address ?? 0,
      );
    }

    const view = new DataView(this.memory.buffer);
    this.writeU64(this.headerAddress + 16, owned.nextHandle);
    view.setUint32(this.headerAddress + 24, target.length, true);
    view.setUint32(this.headerAddress + 28, 0, true);
    this.writeU64(
      this.headerAddress + 32,
      target[0]?.allocation.address ?? 0,
    );
    view.setUint32(this.headerAddress + 88, transactionTarget.length, true);
    view.setUint32(this.headerAddress + 92, 0, true);
    this.writeU64(
      this.headerAddress + 96,
      transactionTarget[0]?.allocation.address ?? 0,
    );
    // WHY: generation is the publication fence consumed by other Workers.
    // Write it only after every reachable record and header field is complete;
    // otherwise a pthread could observe "new" and instantiate a half-written
    // function recipe graph.
    this.writeGeneration(this.headerAddress, generation);
    this.generationFence?.write(generation);

    const stale = [...this.modules.values()].filter(
      ({ state }) => !targetNames.has(state.name),
    );
    const staleTransactions = [...this.transactions.values()].filter(
      ({ state }) => !transactionTokens.has(state.token),
    );
    this.modules = new Map(target.map((entry) => [entry.state.name, entry]));
    this.transactions = new Map(
      transactionTarget.map((entry) => [entry.state.token, entry]),
    );
    this.state = {
      generation,
      tableStateRoot: this.state.tableStateRoot,
      tableCheckpointGeneration: this.state.tableCheckpointGeneration,
      tablePatches: this.state.tablePatches,
      nextHandle: owned.nextHandle,
      libraries: target.map(({ state }) => state),
      transactions: transactionTarget.map(({ state }) => state),
    };
    for (const entry of stale) this.deallocate(entry.allocation);
    for (const entry of replaced) this.deallocate(entry.allocation);
    for (const entry of staleTransactions) this.deallocate(entry.allocation);
    return this.copyState(this.state);
  }

  /**
   * Publish a sealed typed table snapshot while the process writer lock is held.
   */
  publishTableState(tableStateRoot: number): DylinkForkTablePublication {
    checkedAddress(tableStateRoot, `${this.label}: table-state root`);
    this.refreshIndex();
    this.ensureHeader(this.state.nextHandle);
    const previousTableStateRoot = this.state.tableStateRoot;
    const generation = this.nextGeneration(this.state.generation);
    const stalePatches = this.tablePatchRecords;
    this.writeU64(this.headerAddress + 48, tableStateRoot);
    this.writeU64(this.headerAddress + 56, 0);
    this.writeU64(this.headerAddress + 64, 0);
    const view = new DataView(this.memory.buffer);
    view.setUint32(this.headerAddress + 72, 0, true);
    view.setUint32(this.headerAddress + 76, 0, true);
    this.writeU64(this.headerAddress + 80, generation);
    this.writeGeneration(this.headerAddress, generation);
    // This fixed shared-memory word is the Wasm fast-path fence. It must be
    // last so a changed value always names a complete header and sealed arena.
    this.generationFence?.write(generation);
    this.state = {
      ...this.state,
      generation,
      tableStateRoot,
      tableCheckpointGeneration: generation,
      tablePatches: [],
    };
    this.tablePatchRecords = [];
    for (const record of stalePatches) {
      this.deallocate(record.allocation);
    }
    return {
      snapshot: this.copyState(this.state),
      previousTableStateRoot,
    };
  }

  /**
   * Whether one deterministic funcref patch fits before bounded compaction.
   */
  canPublishTablePatch(patch: DylinkForkTablePatch): boolean {
    this.refreshIndex();
    const owned = this.validateTablePatch(patch);
    const size = this.tablePatchSize(owned);
    return (
      this.tablePatchRecords.length < MAX_TABLE_PATCH_RECORDS
      && this.tablePatchBytes() + size <= MAX_TABLE_PATCH_BYTES
    );
  }

  /**
   * Append one deterministic funcref patch under the process writer lock.
   *
   * A caller that receives `false` from `canPublishTablePatch` first publishes
   * a full typed checkpoint. This keeps retained journal memory bounded while
   * making the common mutation proportional only to its changed range.
   */
  publishTablePatch(
    patch: DylinkForkTablePatch,
  ): DylinkForkTablePatchPublication {
    const owned = this.validateTablePatch(patch);
    this.refreshIndex();
    this.ensureHeader(this.state.nextHandle);
    const size = this.tablePatchSize(owned);
    if (
      this.tablePatchRecords.length >= MAX_TABLE_PATCH_RECORDS
      || this.tablePatchBytes() + size > MAX_TABLE_PATCH_BYTES
    ) {
      throw new Error(`${this.label}: table patch journal requires compaction`);
    }
    const generation = this.nextGeneration(this.state.generation);
    const record = this.allocateTablePatch(owned, generation);
    const previous = this.tablePatchRecords.at(-1);
    if (previous) {
      this.writeU64(previous.allocation.address + 8, record.allocation.address);
    } else {
      this.writeU64(this.headerAddress + 56, record.allocation.address);
    }
    this.writeU64(this.headerAddress + 64, record.allocation.address);
    const view = new DataView(this.memory.buffer);
    view.setUint32(
      this.headerAddress + 72,
      this.tablePatchRecords.length + 1,
      true,
    );
    view.setUint32(
      this.headerAddress + 76,
      this.tablePatchBytes() + size,
      true,
    );
    this.writeGeneration(this.headerAddress, generation);
    this.generationFence?.write(generation);
    this.tablePatchRecords = [...this.tablePatchRecords, record];
    this.state = {
      ...this.state,
      generation,
      tablePatches: [...this.state.tablePatches, record.patch],
    };
    return { snapshot: this.copyState(this.state) };
  }

  private refreshIndex(): void {
    const head = this.readHead();
    if (head === 0) {
      if (this.headerAddress !== 0 || this.state.generation !== 0) {
        this.resetIndex();
      }
      this.indexed = true;
      return;
    }
    if (
      this.indexed
      && this.headerAddress === head
      && this.state.generation === this.generation()
    ) {
      return;
    }
    this.resetIndex();
    this.ensureIndexed();
  }

  private resetIndex(): void {
    this.headerAddress = 0;
    this.indexed = false;
    this.modules = new Map();
    this.transactions = new Map();
    this.tablePatchRecords = [];
    this.state = {
      generation: 0,
      tableStateRoot: 0,
      tableCheckpointGeneration: 0,
      tablePatches: [],
      nextHandle: FIRST_DYLINK_HANDLE,
      libraries: [],
      transactions: [],
    };
  }

  private ensureIndexed(): void {
    if (this.indexed) return;
    const head = this.readHead();
    if (head === 0) {
      this.indexed = true;
      return;
    }
    this.headerAddress = this.checkedRange(
      head,
      ARCHIVE_HEADER_SIZE,
      "archive header",
    );
    const view = new DataView(this.memory.buffer);
    if (view.getUint32(head, true) !== ARCHIVE_MAGIC) {
      throw new Error(`${this.label}: invalid dylink fork archive magic`);
    }
    if (view.getUint16(head + 4, true) !== ARCHIVE_VERSION) {
      throw new Error(`${this.label}: unsupported dylink fork archive version`);
    }
    if (view.getUint16(head + 6, true) !== ARCHIVE_HEADER_SIZE) {
      throw new Error(`${this.label}: invalid dylink fork archive header size`);
    }
    if (view.getUint8(head + 8) !== this.ptrWidth) {
      throw new Error(`${this.label}: dylink fork archive pointer-width mismatch`);
    }
    for (let offset = 9; offset < 16; offset++) {
      if (view.getUint8(head + offset) !== 0) {
        throw new Error(`${this.label}: nonzero dylink fork archive header reserved byte`);
      }
    }
    const nextHandle = checkedNextHandle(this.readU64(head + 16, "next handle"));
    const count = view.getUint32(head + 24, true);
    const maximumPhysicalModules = Math.floor(
      (this.memory.buffer.byteLength - ARCHIVE_HEADER_SIZE)
        / MODULE_HEADER_SIZE,
    );
    if (count > maximumPhysicalModules) {
      throw new RangeError(
        `${this.label}: dylink fork archive module count exceeds its memory geometry`,
      );
    }
    if (view.getUint32(head + 28, true) !== 0) {
      throw new Error(`${this.label}: nonzero dylink fork archive header flags`);
    }
    let cursor = this.readU64(head + 32, "first module");
    const generation = this.readGeneration(head);
    if (generation === 0) {
      throw new Error(`${this.label}: unpublished dylink fork archive`);
    }
    const fenced = this.generationFence?.read();
    if (fenced !== undefined && fenced !== generation) {
      throw new Error(
        `${this.label}: dylink archive generation does not match its publication fence`,
      );
    }
    const tableStateRoot = this.readU64(head + 48, "table-state root");
    if (tableStateRoot !== 0) {
      this.checkedRange(tableStateRoot, 1, "table-state root");
    }
    let tablePatchCursor = this.readU64(head + 56, "first table patch");
    const tablePatchTail = this.readU64(head + 64, "last table patch");
    const tablePatchCount = view.getUint32(head + 72, true);
    const declaredTablePatchBytes = view.getUint32(head + 76, true);
    const tableCheckpointGeneration = this.readU64(
      head + 80,
      "table checkpoint generation",
    );
    const transactionCount = view.getUint32(head + 88, true);
    if (view.getUint32(head + 92, true) !== 0) {
      throw new Error(`${this.label}: nonzero dylink transaction flags`);
    }
    let transactionCursor = this.readU64(
      head + 96,
      "first staged transaction",
    );
    const maximumPhysicalTransactions = Math.floor(
      (this.memory.buffer.byteLength - ARCHIVE_HEADER_SIZE)
        / TRANSACTION_HEADER_SIZE,
    );
    if (transactionCount > maximumPhysicalTransactions) {
      throw new RangeError(
        `${this.label}: staged transaction count exceeds its memory geometry`,
      );
    }
    if ((transactionCount === 0) !== (transactionCursor === 0)) {
      throw new Error(
        `${this.label}: staged transaction count/head mismatch`,
      );
    }
    if (
      tableCheckpointGeneration > generation
      || (tableStateRoot === 0) !== (tableCheckpointGeneration === 0)
    ) {
      throw new Error(`${this.label}: inconsistent table checkpoint`);
    }
    if (
      tablePatchCount > MAX_TABLE_PATCH_RECORDS
      || declaredTablePatchBytes > MAX_TABLE_PATCH_BYTES
    ) {
      throw new RangeError(`${this.label}: table patch journal is too large`);
    }
    if (
      (tablePatchCount === 0)
        !== (tablePatchCursor === 0 && tablePatchTail === 0)
    ) {
      throw new Error(`${this.label}: table patch count/head/tail mismatch`);
    }
    if ((count === 0) !== (cursor === 0)) {
      throw new Error(`${this.label}: dylink fork archive count/head mismatch`);
    }

    const intervals: Array<{ start: number; end: number }> = [{
      start: head,
      end: head + ARCHIVE_HEADER_SIZE,
    }];
    const seenAddresses = new Set<number>();
    const seenNames = new Set<string>();
    const seenActivations = new Set<number>();
    const seenHandles = new Set<number>();
    const libraries: DylinkForkLibraryState[] = [];
    const modules = new Map<string, IndexedModule>();
    for (let ordinal = 0; ordinal < count; ordinal++) {
      if (cursor === 0 || seenAddresses.has(cursor)) {
        throw new Error(`${this.label}: cyclic or truncated dylink fork archive`);
      }
      seenAddresses.add(cursor);
      const decoded = this.readModule(cursor, ordinal, intervals);
      if (seenNames.has(decoded.state.name)) {
        throw new Error(`${this.label}: duplicate archived module ${decoded.state.name}`);
      }
      seenNames.add(decoded.state.name);
      if (decoded.state.activationId !== undefined) {
        if (seenActivations.has(decoded.state.activationId)) {
          throw new Error(
            `${this.label}: duplicate archived activation ${decoded.state.activationId}`,
          );
        }
        seenActivations.add(decoded.state.activationId);
      }
      if (decoded.state.handle !== undefined) {
        if (seenHandles.has(decoded.state.handle)) {
          throw new Error(
            `${this.label}: duplicate archived handle ${decoded.state.handle}`,
          );
        }
        if (decoded.state.handle >= nextHandle) {
          throw new Error(
            `${this.label}: archived handle ${decoded.state.handle} reaches next handle`,
          );
        }
        seenHandles.add(decoded.state.handle);
      }
      libraries.push(decoded.state);
      modules.set(decoded.state.name, decoded);
      cursor = this.readU64(cursor + 8, `module ${ordinal} next`);
    }
    if (cursor !== 0) {
      throw new Error(`${this.label}: dylink fork archive has more records than declared`);
    }
    const transactionRecords: IndexedTransaction[] = [];
    const seenTransactionTokens = new Set<number>();
    for (let ordinal = 0; ordinal < transactionCount; ordinal++) {
      if (
        transactionCursor === 0
        || seenAddresses.has(transactionCursor)
      ) {
        throw new Error(
          `${this.label}: cyclic or truncated staged transaction archive`,
        );
      }
      seenAddresses.add(transactionCursor);
      const decoded = this.readTransaction(
        transactionCursor,
        ordinal,
        intervals,
      );
      if (seenTransactionTokens.has(decoded.state.token)) {
        throw new Error(
          `${this.label}: duplicate staged transaction ${decoded.state.token}`,
        );
      }
      seenTransactionTokens.add(decoded.state.token);
      transactionRecords.push(decoded);
      transactionCursor = this.readU64(
        transactionCursor + 8,
        `staged transaction ${ordinal} next`,
      );
    }
    if (transactionCursor !== 0) {
      throw new Error(
        `${this.label}: staged transaction archive has extra records`,
      );
    }
    const tablePatchRecords: IndexedTablePatch[] = [];
    let previousPatchGeneration = tableCheckpointGeneration;
    let tablePatchBytes = 0;
    for (let ordinal = 0; ordinal < tablePatchCount; ordinal++) {
      if (
        tablePatchCursor === 0
        || seenAddresses.has(tablePatchCursor)
      ) {
        throw new Error(`${this.label}: cyclic or truncated table patch journal`);
      }
      seenAddresses.add(tablePatchCursor);
      const decoded = this.readTablePatch(
        tablePatchCursor,
        ordinal,
        intervals,
      );
      const patchGeneration = decoded.patch.generation;
      if (
        patchGeneration <= previousPatchGeneration
        || patchGeneration > generation
      ) {
        throw new Error(
          `${this.label}: table patch ${ordinal} has non-monotonic generation`,
        );
      }
      previousPatchGeneration = patchGeneration;
      tablePatchBytes += decoded.allocation.size;
      if (tablePatchBytes > MAX_TABLE_PATCH_BYTES) {
        throw new RangeError(`${this.label}: table patch journal byte count overflow`);
      }
      tablePatchRecords.push(decoded);
      tablePatchCursor = this.readU64(
        tablePatchCursor + 8,
        `table patch ${ordinal} next`,
      );
    }
    if (tablePatchCursor !== 0) {
      throw new Error(`${this.label}: table patch journal has extra records`);
    }
    if (
      (tablePatchRecords.at(-1)?.allocation.address ?? 0) !== tablePatchTail
      || tablePatchBytes !== declaredTablePatchBytes
    ) {
      throw new Error(`${this.label}: table patch tail/byte count mismatch`);
    }
    for (const library of libraries) {
      for (const allocation of library.allocations ?? []) {
        const start = allocation.mappingAddress;
        const end = start + allocation.mappingSize;
        if (
          intervals.some(
            (interval) => start < interval.end && interval.start < end,
          )
        ) {
          throw new Error(
            `${this.label}: ${library.name} process mapping overlaps archive storage`,
          );
        }
      }
    }
    const validatedState = this.validateState({
      nextHandle,
      libraries,
      transactions: transactionRecords.map(({ state }) => state),
    });
    this.modules = modules;
    this.transactions = new Map(
      transactionRecords.map((entry) => [entry.state.token, entry]),
    );
    this.tablePatchRecords = tablePatchRecords;
    this.state = {
      generation,
      tableStateRoot,
      tableCheckpointGeneration,
      tablePatches: tablePatchRecords.map(({ patch }) => patch),
      nextHandle: validatedState.nextHandle,
      libraries: validatedState.libraries,
      transactions: validatedState.transactions ?? [],
    };
    this.indexed = true;
  }

  private ensureHeader(nextHandle: number): void {
    if (this.headerAddress !== 0) return;
    const allocation = this.allocate(ARCHIVE_HEADER_SIZE);
    if (allocation.size !== ARCHIVE_HEADER_SIZE) {
      throw new Error(`${this.label}: archive allocator changed the header size`);
    }
    const address = this.checkedRange(
      allocation.address,
      allocation.size,
      "new archive header",
    );
    const bytes = new Uint8Array(this.memory.buffer, address, allocation.size);
    bytes.fill(0);
    const view = new DataView(this.memory.buffer);
    view.setUint32(address, ARCHIVE_MAGIC, true);
    view.setUint16(address + 4, ARCHIVE_VERSION, true);
    view.setUint16(address + 6, ARCHIVE_HEADER_SIZE, true);
    view.setUint8(address + 8, this.ptrWidth);
    this.writeU64(address + 16, nextHandle);
    this.headerAddress = address;
    // The zero generation keeps this header explicitly unpublished until
    // sync() has linked every module record and performs the final release.
    this.writeHead(address);
  }

  private validateTablePatch(
    patch: DylinkForkTablePatch,
  ): DylinkForkTablePatch {
    if (patch.generation !== undefined) {
      throw new Error(`${this.label}: caller assigned a table patch generation`);
    }
    const activationId = checkedU32(
      patch.activationId,
      `${this.label}: table patch activation`,
    );
    const ownerId = checkedU32(
      patch.ownerId,
      `${this.label}: table patch owner`,
      false,
    );
    const start = checkedExactNonnegative(
      patch.start,
      `${this.label}: table patch start`,
    );
    const tableLength = checkedExactNonnegative(
      patch.tableLength,
      `${this.label}: table patch length`,
    );
    if (!Array.isArray(patch.runs) || patch.runs.length === 0) {
      throw new Error(`${this.label}: table patch has no runs`);
    }
    checkedU32(
      patch.runs.length,
      `${this.label}: table patch run count`,
      false,
    );
    let changed = 0;
    const runs = patch.runs.map((run, ordinal) => {
      const length = checkedExactNonnegative(
        run.length,
        `${this.label}: table patch run ${ordinal} length`,
      );
      if (length === 0) {
        throw new RangeError(`${this.label}: table patch run ${ordinal} is empty`);
      }
      changed += length;
      if (!Number.isSafeInteger(changed)) {
        throw new RangeError(`${this.label}: table patch range is too large`);
      }
      if (run.function === null) {
        return Object.freeze({ length, function: null });
      }
      if (
        typeof run.function !== "object"
        || run.function === null
      ) {
        throw new TypeError(
          `${this.label}: table patch run ${ordinal} has no function recipe`,
        );
      }
      return Object.freeze({
        length,
        function: Object.freeze({
          activationId: checkedU32(
            run.function.activationId,
            `${this.label}: table patch run ${ordinal} activation`,
          ),
          ordinal: checkedU32(
            run.function.ordinal,
            `${this.label}: table patch run ${ordinal} function ordinal`,
          ),
        }),
      });
    });
    if (start + changed > tableLength) {
      throw new RangeError(`${this.label}: table patch exceeds final table length`);
    }
    return Object.freeze({
      activationId,
      ownerId,
      start,
      tableLength,
      runs: Object.freeze(runs),
    });
  }

  private tablePatchSize(patch: DylinkForkTablePatch): number {
    return TABLE_PATCH_HEADER_SIZE + patch.runs.length * TABLE_PATCH_RUN_SIZE;
  }

  private tablePatchBytes(): number {
    return this.tablePatchRecords.reduce(
      (total, record) => total + record.allocation.size,
      0,
    );
  }

  private allocateTablePatch(
    patch: DylinkForkTablePatch,
    generation: number,
  ): IndexedTablePatch {
    const totalSize = this.tablePatchSize(patch);
    const allocation = this.allocate(totalSize);
    if (allocation.size !== totalSize) {
      throw new Error(`${this.label}: archive allocator changed a table patch size`);
    }
    const address = this.checkedRange(
      allocation.address,
      allocation.size,
      "new table patch",
    );
    const bytes = new Uint8Array(this.memory.buffer, address, totalSize);
    bytes.fill(0);
    const view = new DataView(this.memory.buffer);
    view.setUint32(address, TABLE_PATCH_MAGIC, true);
    view.setUint16(address + 4, TABLE_PATCH_VERSION, true);
    view.setUint16(address + 6, TABLE_PATCH_HEADER_SIZE, true);
    this.writeU64(address + 16, totalSize);
    this.writeU64(address + 24, generation);
    view.setUint32(address + 32, patch.activationId, true);
    view.setUint32(address + 36, patch.ownerId, true);
    this.writeU64(address + 40, patch.start);
    this.writeU64(address + 48, patch.tableLength);
    view.setUint32(address + 56, patch.runs.length, true);
    for (const [ordinal, run] of patch.runs.entries()) {
      const offset = address + TABLE_PATCH_HEADER_SIZE
        + ordinal * TABLE_PATCH_RUN_SIZE;
      this.writeU64(offset, run.length);
      view.setUint32(offset + 8, run.function === null ? 0 : 1, true);
      view.setUint32(offset + 12, run.function?.activationId ?? 0, true);
      view.setUint32(offset + 16, run.function?.ordinal ?? 0, true);
      view.setUint32(offset + 20, 0, true);
    }
    return {
      allocation,
      patch: Object.freeze({
        ...this.copyTablePatch(patch),
        generation,
      }),
    };
  }

  private readTablePatch(
    address: number,
    ordinal: number,
    intervals: Array<{ start: number; end: number }>,
  ): IndexedTablePatch {
    this.checkedRange(
      address,
      TABLE_PATCH_HEADER_SIZE,
      `table patch ${ordinal} header`,
    );
    const view = new DataView(this.memory.buffer);
    if (view.getUint32(address, true) !== TABLE_PATCH_MAGIC) {
      throw new Error(`${this.label}: table patch ${ordinal} has invalid magic`);
    }
    if (view.getUint16(address + 4, true) !== TABLE_PATCH_VERSION) {
      throw new Error(`${this.label}: table patch ${ordinal} has unsupported version`);
    }
    if (view.getUint16(address + 6, true) !== TABLE_PATCH_HEADER_SIZE) {
      throw new Error(`${this.label}: table patch ${ordinal} has invalid header size`);
    }
    const runCount = view.getUint32(address + 56, true);
    const totalSize = this.readU64(
      address + 16,
      `table patch ${ordinal} allocation size`,
    );
    const expectedSize =
      TABLE_PATCH_HEADER_SIZE + runCount * TABLE_PATCH_RUN_SIZE;
    if (totalSize !== expectedSize) {
      throw new Error(`${this.label}: table patch ${ordinal} has invalid size`);
    }
    this.checkedRange(address, totalSize, `table patch ${ordinal}`);
    const end = address + totalSize;
    if (intervals.some((interval) => address < interval.end && interval.start < end)) {
      throw new Error(`${this.label}: table patch ${ordinal} overlaps an archive record`);
    }
    intervals.push({ start: address, end });
    const generation = this.readU64(
      address + 24,
      `table patch ${ordinal} generation`,
    );
    if (generation === 0 || view.getUint32(address + 60, true) !== 0) {
      throw new Error(`${this.label}: table patch ${ordinal} has invalid metadata`);
    }
    const runs: DylinkForkTablePatchRun[] = [];
    for (let index = 0; index < runCount; index++) {
      const offset = address + TABLE_PATCH_HEADER_SIZE
        + index * TABLE_PATCH_RUN_SIZE;
      const length = this.readU64(
        offset,
        `table patch ${ordinal} run ${index} length`,
      );
      const kind = view.getUint32(offset + 8, true);
      const activationId = view.getUint32(offset + 12, true);
      const functionOrdinal = view.getUint32(offset + 16, true);
      if (view.getUint32(offset + 20, true) !== 0 || (kind !== 0 && kind !== 1)) {
        throw new Error(`${this.label}: table patch ${ordinal} run ${index} is invalid`);
      }
      if (kind === 0 && (activationId !== 0 || functionOrdinal !== 0)) {
        throw new Error(
          `${this.label}: null table patch run ${index} has a function coordinate`,
        );
      }
      runs.push({
        length,
        function: kind === 0
          ? null
          : { activationId, ordinal: functionOrdinal },
      });
    }
    const patch = this.validateTablePatch({
      activationId: view.getUint32(address + 32, true),
      ownerId: view.getUint32(address + 36, true),
      start: this.readU64(address + 40, `table patch ${ordinal} start`),
      tableLength: this.readU64(
        address + 48,
        `table patch ${ordinal} table length`,
      ),
      runs,
    });
    return {
      allocation: { address, size: totalSize },
      patch: Object.freeze({
        ...this.copyTablePatch(patch),
        generation,
      }),
    };
  }

  private allocateTransaction(
    state: DylinkForkTransactionState,
  ): IndexedTransaction {
    const name = new TextEncoder().encode(state.name);
    const nameAligned = align8(name.length);
    const totalSize =
      TRANSACTION_HEADER_SIZE + nameAligned + state.moduleBytes.length;
    const allocation = this.allocate(totalSize);
    if (allocation.size !== totalSize) {
      throw new Error(
        `${this.label}: archive allocator changed a transaction record size`,
      );
    }
    const address = this.checkedRange(
      allocation.address,
      allocation.size,
      `new staged transaction ${state.token}`,
    );
    const bytes = new Uint8Array(this.memory.buffer, address, totalSize);
    bytes.fill(0);
    const view = new DataView(this.memory.buffer);
    view.setUint32(address, TRANSACTION_MAGIC, true);
    view.setUint16(address + 4, TRANSACTION_VERSION, true);
    view.setUint16(address + 6, TRANSACTION_HEADER_SIZE, true);
    this.writeU64(address + 16, totalSize);
    view.setUint32(address + 24, state.token, true);
    view.setUint32(address + 28, name.length, true);
    view.setUint32(address + 32, state.moduleBytes.length, true);
    view.setUint32(
      address + 36,
      state.globalVisibility ? TRANSACTION_FLAG_GLOBAL : 0,
      true,
    );
    bytes.set(
      computeForkModuleTemplateIdSync(state.moduleBytes),
      TRANSACTION_DIGEST_OFFSET,
    );
    bytes.set(name, TRANSACTION_HEADER_SIZE);
    bytes.set(
      state.moduleBytes,
      TRANSACTION_HEADER_SIZE + nameAligned,
    );
    return {
      allocation,
      state: this.copyTransaction(state),
    };
  }

  private readTransaction(
    address: number,
    ordinal: number,
    intervals: Array<{ start: number; end: number }>,
  ): IndexedTransaction {
    this.checkedRange(
      address,
      TRANSACTION_HEADER_SIZE,
      `staged transaction ${ordinal} header`,
    );
    const view = new DataView(this.memory.buffer);
    if (view.getUint32(address, true) !== TRANSACTION_MAGIC) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} has invalid magic`,
      );
    }
    if (view.getUint16(address + 4, true) !== TRANSACTION_VERSION) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} has unsupported version`,
      );
    }
    if (view.getUint16(address + 6, true) !== TRANSACTION_HEADER_SIZE) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} has invalid header size`,
      );
    }
    const allocationSize = this.readU64(
      address + 16,
      `staged transaction ${ordinal} allocation size`,
    );
    const nameLength = view.getUint32(address + 28, true);
    const bytesLength = view.getUint32(address + 32, true);
    const expectedSize =
      TRANSACTION_HEADER_SIZE + align8(nameLength) + bytesLength;
    const flags = view.getUint32(address + 36, true);
    if (
      allocationSize !== expectedSize
      || (flags & ~TRANSACTION_FLAG_GLOBAL) !== 0
    ) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} has invalid metadata`,
      );
    }
    this.checkedRange(
      address,
      allocationSize,
      `staged transaction ${ordinal}`,
    );
    const end = address + allocationSize;
    if (
      intervals.some((interval) =>
        address < interval.end && interval.start < end
      )
    ) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} overlaps an archive record`,
      );
    }
    intervals.push({ start: address, end });
    const nameBytes = new Uint8Array(
      this.memory.buffer,
      address + TRANSACTION_HEADER_SIZE,
      nameLength,
    );
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(nameBytes),
      );
    } catch {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} has invalid UTF-8 name`,
      );
    }
    const moduleBytes = new Uint8Array(
      new Uint8Array(
        this.memory.buffer,
        address + TRANSACTION_HEADER_SIZE + align8(nameLength),
        bytesLength,
      ),
    );
    const expectedDigest = new Uint8Array(
      this.memory.buffer,
      address + TRANSACTION_DIGEST_OFFSET,
      MODULE_DIGEST_SIZE,
    );
    if (
      !equalBytes(
        expectedDigest,
        computeForkModuleTemplateIdSync(moduleBytes),
      )
    ) {
      throw new Error(
        `${this.label}: staged transaction ${ordinal} failed SHA-256 validation`,
      );
    }
    const state = this.validateTransaction({
      token: view.getUint32(address + 24, true),
      name,
      moduleBytes,
      globalVisibility: (flags & TRANSACTION_FLAG_GLOBAL) !== 0,
    });
    return {
      allocation: { address, size: allocationSize },
      state,
    };
  }

  private allocateModule(state: DylinkForkLibraryState): IndexedModule {
    const name = new TextEncoder().encode(state.name);
    const nameAligned = align8(name.length);
    const moduleBytesAligned = align8(state.moduleBytes.length);
    const providers = encodeProviderDependencies(state);
    const providerBytesAligned = align8(providers.bytes.length);
    const allocations = canonicalMemoryAllocations(state);
    const allocationBytesLength =
      allocations.length * MODULE_ALLOCATION_SIZE;
    checkedU32(
      allocationBytesLength,
      `${state.name}: process allocation archive size`,
    );
    const totalSize =
      MODULE_HEADER_SIZE
      + nameAligned
      + moduleBytesAligned
      + providerBytesAligned
      + allocationBytesLength;
    const allocation = this.allocate(totalSize);
    if (allocation.size !== totalSize) {
      throw new Error(`${this.label}: archive allocator changed a module record size`);
    }
    const address = this.checkedRange(
      allocation.address,
      allocation.size,
      `new module ${state.name}`,
    );
    const bytes = new Uint8Array(this.memory.buffer, address, totalSize);
    bytes.fill(0);
    const view = new DataView(this.memory.buffer);
    view.setUint32(address, MODULE_MAGIC, true);
    view.setUint16(address + 4, MODULE_VERSION, true);
    view.setUint16(address + 6, MODULE_HEADER_SIZE, true);
    this.writeU64(address + 16, totalSize);
    this.writeU64(address + 24, state.memoryBase);
    this.writeU64(address + 32, state.tableBase);
    this.writeU64(address + 40, state.tlsBase ?? 0);
    view.setUint32(address + 48, state.activationId ?? 0, true);
    view.setUint32(address + 52, state.handle ?? 0, true);
    view.setUint32(address + 56, state.refCount ?? 0, true);
    view.setUint32(address + 60, name.length, true);
    view.setUint32(address + 64, state.moduleBytes.length, true);
    view.setUint32(
      address + 68,
      (state.initialization === undefined ? 0 : MODULE_FLAG_INITIALIZING)
        | (state.globalVisibility ? MODULE_FLAG_GLOBAL : 0)
        | (
          state.committedGlobalRoot
            ? MODULE_FLAG_COMMITTED_GLOBAL_ROOT
            : 0
        ),
      true,
    );
    bytes.set(
      computeForkModuleTemplateIdSync(state.moduleBytes),
      MODULE_DIGEST_OFFSET,
    );
    bytes.set(name, MODULE_HEADER_SIZE);
    bytes.set(state.moduleBytes, MODULE_HEADER_SIZE + nameAligned);
    bytes.set(
      providers.bytes,
      MODULE_HEADER_SIZE + nameAligned + moduleBytesAligned,
    );
    const allocationOffset =
      address
      + MODULE_HEADER_SIZE
      + nameAligned
      + moduleBytesAligned
      + providerBytesAligned;
    for (const [index, allocation] of allocations.entries()) {
      const offset = allocationOffset + index * MODULE_ALLOCATION_SIZE;
      this.writeU64(offset, allocation.address);
      this.writeU64(offset + 8, allocation.size);
      this.writeU64(offset + 16, allocation.mappingAddress);
      this.writeU64(offset + 24, allocation.mappingSize);
    }
    view.setUint32(
      address + 104,
      state.initialization?.transactionToken ?? 0,
      true,
    );
    view.setUint32(
      address + 108,
      state.initialization === undefined
        ? 0
        : initializationStageCode(state.initialization.stage),
      true,
    );
    this.writeU64(
      address + 112,
      state.initialization?.tableIndex ?? 0,
    );
    view.setUint32(address + 120, providers.bytes.length, true);
    view.setUint32(address + 124, providers.count, true);
    view.setUint32(address + 128, allocationBytesLength, true);
    view.setUint32(address + 132, allocations.length, true);
    return {
      allocation,
      state: this.copyLibrary(state),
    };
  }

  private readModule(
    address: number,
    ordinal: number,
    intervals: Array<{ start: number; end: number }>,
  ): IndexedModule {
    this.checkedRange(address, MODULE_HEADER_SIZE, `module ${ordinal} header`);
    const view = new DataView(this.memory.buffer);
    if (view.getUint32(address, true) !== MODULE_MAGIC) {
      throw new Error(`${this.label}: module ${ordinal} has invalid archive magic`);
    }
    if (view.getUint16(address + 4, true) !== MODULE_VERSION) {
      throw new Error(`${this.label}: module ${ordinal} has unsupported archive version`);
    }
    if (view.getUint16(address + 6, true) !== MODULE_HEADER_SIZE) {
      throw new Error(`${this.label}: module ${ordinal} has invalid archive header size`);
    }
    const allocationSize = this.readU64(
      address + 16,
      `module ${ordinal} allocation size`,
    );
    const nameLength = view.getUint32(address + 60, true);
    const bytesLength = view.getUint32(address + 64, true);
    const providerBytesLength = view.getUint32(address + 120, true);
    const providerCount = view.getUint32(address + 124, true);
    const allocationBytesLength = view.getUint32(address + 128, true);
    const allocationCount = view.getUint32(address + 132, true);
    if (
      allocationBytesLength
        !== allocationCount * MODULE_ALLOCATION_SIZE
    ) {
      throw new Error(
        `${this.label}: module ${ordinal} has noncanonical allocation metadata`,
      );
    }
    const expectedSize =
      MODULE_HEADER_SIZE
      + align8(nameLength)
      + align8(bytesLength)
      + align8(providerBytesLength)
      + allocationBytesLength;
    if (allocationSize !== expectedSize) {
      throw new Error(`${this.label}: module ${ordinal} has noncanonical allocation size`);
    }
    this.checkedRange(address, allocationSize, `module ${ordinal} allocation`);
    const end = address + allocationSize;
    if (intervals.some((interval) => address < interval.end && interval.start < end)) {
      throw new Error(`${this.label}: module ${ordinal} overlaps another archive record`);
    }
    intervals.push({ start: address, end });
    const flags = view.getUint32(address + 68, true);
    if ((flags & ~MODULE_FLAG_KNOWN_MASK) !== 0) {
      throw new Error(`${this.label}: module ${ordinal} has unknown archive flags`);
    }
    const nameBytes = new Uint8Array(
      this.memory.buffer,
      address + MODULE_HEADER_SIZE,
      nameLength,
    );
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(nameBytes),
      );
    } catch {
      throw new Error(`${this.label}: module ${ordinal} has invalid UTF-8 name`);
    }
    if (name.length === 0) {
      throw new Error(`${this.label}: module ${ordinal} has an empty name`);
    }
    const moduleBytes = new Uint8Array(
      new Uint8Array(
        this.memory.buffer,
        address + MODULE_HEADER_SIZE + align8(nameLength),
        bytesLength,
      ),
    );
    const providerBytes = new Uint8Array(
      new Uint8Array(
        this.memory.buffer,
        address
          + MODULE_HEADER_SIZE
          + align8(nameLength)
          + align8(bytesLength),
        providerBytesLength,
      ),
    );
    const providerDependencies = decodeProviderDependencies(
      providerBytes,
      providerCount,
      `${this.label}: module ${name}`,
    );
    const allocationOffset =
      address
      + MODULE_HEADER_SIZE
      + align8(nameLength)
      + align8(bytesLength)
      + align8(providerBytesLength);
    const allocations = Array.from(
      { length: allocationCount },
      (_, index) => {
        const offset = allocationOffset + index * MODULE_ALLOCATION_SIZE;
        return {
          address: this.readU64(
            offset,
            `${name} allocation ${index} address`,
          ),
          size: this.readU64(
            offset + 8,
            `${name} allocation ${index} size`,
          ),
          mappingAddress: this.readU64(
            offset + 16,
            `${name} allocation ${index} mapping address`,
          ),
          mappingSize: this.readU64(
            offset + 24,
            `${name} allocation ${index} mapping size`,
          ),
        };
      },
    );
    const expectedDigest = new Uint8Array(
      this.memory.buffer,
      address + MODULE_DIGEST_OFFSET,
      MODULE_DIGEST_SIZE,
    );
    if (!equalBytes(expectedDigest, computeForkModuleTemplateIdSync(moduleBytes))) {
      throw new Error(`${this.label}: module ${name} failed archive SHA-256 validation`);
    }
    const activationId = view.getUint32(address + 48, true);
    const handle = view.getUint32(address + 52, true);
    const refCount = view.getUint32(address + 56, true);
    if ((handle === 0) !== (refCount === 0)) {
      throw new Error(`${this.label}: module ${name} has inconsistent handle/refcount`);
    }
    const initializing = (flags & MODULE_FLAG_INITIALIZING) !== 0;
    const transactionToken = view.getUint32(address + 104, true);
    const stageCode = view.getUint32(address + 108, true);
    const initializationTableIndex = this.readU64(
      address + 112,
      `${name} initialization table index`,
    );
    if (
      initializing
        !== (
          transactionToken !== 0
          && stageCode !== 0
          && initializationTableIndex !== 0
        )
    ) {
      throw new Error(
        `${this.label}: module ${name} has inconsistent initialization metadata`,
      );
    }
    const state: DylinkForkLibraryState = {
      name,
      moduleBytes,
      memoryBase: this.readU64(address + 24, `${name} memory base`),
      tableBase: this.readU64(address + 32, `${name} table base`),
      activationId: activationId === 0 ? undefined : activationId,
      tlsBase: this.optionalPositiveU64(address + 40, `${name} TLS base`),
      globalVisibility: (flags & MODULE_FLAG_GLOBAL) !== 0,
      committedGlobalRoot:
        (flags & MODULE_FLAG_COMMITTED_GLOBAL_ROOT) !== 0
          ? true
          : undefined,
      ...(providerDependencies.length === 0
        ? {}
        : { providerDependencies }),
      ...(allocations.length === 0 ? {} : { allocations }),
      handle: handle === 0 ? undefined : handle,
      refCount: refCount === 0 ? undefined : refCount,
      ...(initializing
        ? {
            initialization: {
              transactionToken,
              stage: decodeInitializationStage(
                stageCode,
                `${this.label}: module ${name}`,
              ),
              tableIndex: initializationTableIndex,
            },
          }
        : {}),
    };
    this.validateLibrary(state, Number.MAX_SAFE_INTEGER);
    return {
      allocation: { address, size: allocationSize },
      state,
    };
  }

  private validateState(state: DylinkForkState): DylinkForkState {
    const nextHandle = checkedNextHandle(state.nextHandle);
    checkedU32(
      state.libraries.length,
      `${this.label}: live module count`,
    );
    const names = new Set<string>();
    const activations = new Set<number>();
    const handles = new Set<number>();
    const libraries = state.libraries.map((library) => {
      this.validateLibrary(library, nextHandle);
      if (names.has(library.name)) {
        throw new Error(`${this.label}: duplicate live module ${library.name}`);
      }
      names.add(library.name);
      if (library.activationId !== undefined) {
        if (activations.has(library.activationId)) {
          throw new Error(
            `${this.label}: duplicate live activation ${library.activationId}`,
          );
        }
        activations.add(library.activationId);
      }
      if (library.handle !== undefined) {
        if (handles.has(library.handle)) {
          throw new Error(`${this.label}: duplicate live handle ${library.handle}`);
        }
        handles.add(library.handle);
      }
      return this.copyLibrary(library);
    });
    const ownedMappings = libraries
      .flatMap((library) =>
        (library.allocations ?? []).map((allocation) => ({
          name: library.name,
          start: allocation.mappingAddress,
          end: allocation.mappingAddress + allocation.mappingSize,
        }))
      )
      .sort((left, right) => left.start - right.start);
    for (let index = 1; index < ownedMappings.length; index++) {
      const previous = ownedMappings[index - 1]!;
      const current = ownedMappings[index]!;
      if (current.start < previous.end) {
        throw new Error(
          `${this.label}: ${previous.name} and ${current.name} own overlapping mappings`,
        );
      }
    }
    for (const library of libraries) {
      for (const dependency of library.providerDependencies ?? []) {
        if (!names.has(dependency)) {
          throw new Error(
            `${this.label}: ${library.name} names absent runtime provider `
            + dependency,
          );
        }
      }
    }
    const transactionTokens = new Set<number>();
    const transactions = (state.transactions ?? []).map((transaction) => {
      const owned = this.validateTransaction(transaction);
      if (transactionTokens.has(owned.token)) {
        throw new Error(
          `${this.label}: duplicate staged transaction ${owned.token}`,
        );
      }
      transactionTokens.add(owned.token);
      return owned;
    });
    const initializationCounts = new Map<number, number>();
    for (const library of libraries) {
      const initialization = library.initialization;
      if (!initialization) continue;
      if (!transactionTokens.has(initialization.transactionToken)) {
        throw new Error(
          `${this.label}: ${library.name} names absent staged transaction `
          + `${initialization.transactionToken}`,
        );
      }
      initializationCounts.set(
        initialization.transactionToken,
        (initializationCounts.get(initialization.transactionToken) ?? 0) + 1,
      );
    }
    for (const transaction of transactions) {
      if (initializationCounts.get(transaction.token) !== 1) {
        throw new Error(
          `${this.label}: staged transaction ${transaction.token} must own `
          + "exactly one issued initialization entry",
        );
      }
    }
    return {
      nextHandle,
      libraries,
      ...(transactions.length === 0 ? {} : { transactions }),
    };
  }

  private validateTransaction(
    state: DylinkForkTransactionState,
  ): DylinkForkTransactionState {
    const token = checkedU32(
      state.token,
      `${this.label}: staged transaction token`,
      false,
    );
    if (typeof state.name !== "string" || state.name.length === 0) {
      throw new TypeError(
        `${this.label}: staged transaction ${token} has an empty name`,
      );
    }
    if (
      !(state.moduleBytes instanceof Uint8Array)
      || state.moduleBytes.length === 0
    ) {
      throw new TypeError(
        `${this.label}: staged transaction ${token} has no module bytes`,
      );
    }
    if (typeof state.globalVisibility !== "boolean") {
      throw new TypeError(
        `${this.label}: staged transaction ${token} has invalid visibility`,
      );
    }
    return this.copyTransaction({
      token,
      name: state.name,
      moduleBytes: state.moduleBytes,
      globalVisibility: state.globalVisibility,
    });
  }

  private validateLibrary(
    state: DylinkForkLibraryState,
    nextHandle: number,
  ): void {
    if (typeof state.name !== "string" || state.name.length === 0) {
      throw new TypeError(`${this.label}: live module name is empty`);
    }
    if (!(state.moduleBytes instanceof Uint8Array) || state.moduleBytes.length === 0) {
      throw new TypeError(`${this.label}: ${state.name} has no owned module bytes`);
    }
    if (typeof state.globalVisibility !== "boolean") {
      throw new TypeError(`${this.label}: ${state.name} has invalid visibility`);
    }
    if (state.committedGlobalRoot && !state.globalVisibility) {
      throw new Error(
        `${this.label}: ${state.name} is a committed GLOBAL root but is LOCAL`,
      );
    }
    canonicalProviderDependencies(state);
    const allocations = canonicalMemoryAllocations(state);
    for (const [index, allocation] of allocations.entries()) {
      if (
        allocation.mappingAddress
          > this.memory.buffer.byteLength - allocation.mappingSize
      ) {
        throw new RangeError(
          `${this.label}: ${state.name} allocation ${index} escapes linear memory`,
        );
      }
    }
    checkedAddress(state.memoryBase, `${state.name} memory base`, true);
    checkedAddress(state.tableBase, `${state.name} table base`, true);
    if (state.activationId !== undefined) {
      checkedU32(state.activationId, `${state.name} activation id`, false);
    }
    if (state.tlsBase !== undefined) {
      checkedAddress(state.tlsBase, `${state.name} TLS base`);
    }
    const hasHandle = state.handle !== undefined;
    if (hasHandle !== (state.refCount !== undefined)) {
      throw new Error(`${this.label}: ${state.name} handle/refcount presence differs`);
    }
    if (hasHandle) {
      const handle = checkedU32(state.handle!, `${state.name} handle`, false);
      if (handle < FIRST_DYLINK_HANDLE || handle >= nextHandle) {
        throw new RangeError(`${this.label}: ${state.name} handle ${handle} is out of range`);
      }
      checkedU32(state.refCount!, `${state.name} refcount`, false);
    }
    if (state.initialization !== undefined) {
      checkedU32(
        state.initialization.transactionToken,
        `${state.name} initialization transaction`,
        false,
      );
      initializationStageCode(state.initialization.stage);
      checkedAddress(
        state.initialization.tableIndex,
        `${state.name} initialization table index`,
      );
      if (hasHandle) {
        throw new Error(
          `${this.label}: initializing module ${state.name} already has a handle`,
        );
      }
    }
  }

  private requireImmutableMatch(
    current: DylinkForkLibraryState,
    next: DylinkForkLibraryState,
  ): void {
    const currentAllocations = canonicalMemoryAllocations(current);
    const nextAllocations = canonicalMemoryAllocations(next);
    if (
      current.memoryBase !== next.memoryBase
      || current.tableBase !== next.tableBase
      || current.activationId !== next.activationId
      || currentAllocations.length !== nextAllocations.length
      || currentAllocations.some((allocation, index) => {
        const expected = nextAllocations[index];
        return (
          expected === undefined
          || allocation.address !== expected.address
          || allocation.size !== expected.size
          || allocation.mappingAddress !== expected.mappingAddress
          || allocation.mappingSize !== expected.mappingSize
        );
      })
      || (
        current.tlsBase !== next.tlsBase
        && current.initialization === undefined
      )
      || !equalBytes(current.moduleBytes, next.moduleBytes)
    ) {
      throw new Error(
        `${this.label}: live module ${next.name} changed immutable archive identity`,
      );
    }
  }

  private writeMutableState(
    address: number,
    state: DylinkForkLibraryState,
  ): void {
    const view = new DataView(this.memory.buffer);
    this.writeU64(address + 40, state.tlsBase ?? 0);
    view.setUint32(address + 52, state.handle ?? 0, true);
    view.setUint32(address + 56, state.refCount ?? 0, true);
    view.setUint32(
      address + 68,
      (state.initialization === undefined ? 0 : MODULE_FLAG_INITIALIZING)
        | (state.globalVisibility ? MODULE_FLAG_GLOBAL : 0)
        | (
          state.committedGlobalRoot
            ? MODULE_FLAG_COMMITTED_GLOBAL_ROOT
            : 0
        ),
      true,
    );
    view.setUint32(
      address + 104,
      state.initialization?.transactionToken ?? 0,
      true,
    );
    view.setUint32(
      address + 108,
      state.initialization === undefined
        ? 0
        : initializationStageCode(state.initialization.stage),
      true,
    );
    this.writeU64(
      address + 112,
      state.initialization?.tableIndex ?? 0,
    );
  }

  private checkedRange(address: number, size: number, context: string): number {
    checkedAddress(address, `${this.label}: ${context}`);
    if (
      !Number.isSafeInteger(size)
      || size <= 0
      || address > this.memory.buffer.byteLength - size
    ) {
      throw new RangeError(`${this.label}: ${context} escapes linear memory`);
    }
    return address;
  }

  private readU64(address: number, context: string): number {
    const value = new DataView(this.memory.buffer).getBigUint64(address, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${this.label}: ${context} exceeds exact host integers`);
    }
    return Number(value);
  }

  private optionalPositiveU64(
    address: number,
    context: string,
  ): number | undefined {
    const value = this.readU64(address, context);
    return value === 0 ? undefined : checkedAddress(value, context);
  }

  private writeU64(address: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${this.label}: cannot archive inexact u64 ${String(value)}`);
    }
    new DataView(this.memory.buffer).setBigUint64(address, BigInt(value), true);
  }

  private nextGeneration(current: number): number {
    if (
      !Number.isSafeInteger(current)
      || current < 0
      || current >= MAX_EXACT_GENERATION
    ) {
      throw new RangeError(`${this.label}: dylink archive generation is exhausted`);
    }
    return current + 1;
  }

  private readGeneration(header: number): number {
    const address = header + 40;
    let value: bigint;
    if (
      typeof SharedArrayBuffer !== "undefined"
      && this.memory.buffer instanceof SharedArrayBuffer
    ) {
      value = Atomics.load(new BigUint64Array(this.memory.buffer, address, 1), 0);
    } else {
      value = new DataView(this.memory.buffer).getBigUint64(address, true);
    }
    if (value > BigInt(MAX_EXACT_GENERATION)) {
      throw new RangeError(`${this.label}: dylink archive generation is inexact`);
    }
    return Number(value);
  }

  private writeGeneration(header: number, generation: number): void {
    if (
      !Number.isSafeInteger(generation)
      || generation <= 0
      || generation > MAX_EXACT_GENERATION
    ) {
      throw new RangeError(`${this.label}: invalid dylink archive generation`);
    }
    const address = header + 40;
    if (
      typeof SharedArrayBuffer !== "undefined"
      && this.memory.buffer instanceof SharedArrayBuffer
    ) {
      Atomics.store(
        new BigUint64Array(this.memory.buffer, address, 1),
        0,
        BigInt(generation),
      );
    } else {
      new DataView(this.memory.buffer).setBigUint64(
        address,
        BigInt(generation),
        true,
      );
    }
  }

  private copyLibrary(state: DylinkForkLibraryState): DylinkForkLibraryState {
    const providerDependencies = canonicalProviderDependencies(state);
    const allocations = canonicalMemoryAllocations(state);
    return {
      name: state.name,
      moduleBytes: new Uint8Array(state.moduleBytes),
      memoryBase: state.memoryBase,
      tableBase: state.tableBase,
      ...(state.activationId === undefined
        ? {}
        : { activationId: state.activationId }),
      ...(state.tlsBase === undefined ? {} : { tlsBase: state.tlsBase }),
      globalVisibility: state.globalVisibility,
      ...(state.committedGlobalRoot
        ? { committedGlobalRoot: true }
        : {}),
      ...(providerDependencies.length === 0
        ? {}
        : { providerDependencies }),
      ...(allocations.length === 0 ? {} : { allocations }),
      ...(state.handle === undefined ? {} : { handle: state.handle }),
      ...(state.refCount === undefined ? {} : { refCount: state.refCount }),
      ...(state.initialization === undefined
        ? {}
        : {
            initialization: {
              transactionToken: state.initialization.transactionToken,
              stage: state.initialization.stage,
              tableIndex: state.initialization.tableIndex,
            },
          }),
    };
  }

  private copyTransaction(
    state: DylinkForkTransactionState,
  ): DylinkForkTransactionState {
    return {
      token: state.token,
      name: state.name,
      moduleBytes: new Uint8Array(state.moduleBytes),
      globalVisibility: state.globalVisibility,
    };
  }

  private copyTablePatch(
    patch: DylinkForkTablePatch,
  ): DylinkForkTablePatch {
    return {
      ...(patch.generation === undefined
        ? {}
        : { generation: patch.generation }),
      activationId: patch.activationId,
      ownerId: patch.ownerId,
      start: patch.start,
      tableLength: patch.tableLength,
      runs: patch.runs.map((run) => ({
        length: run.length,
        function: run.function === null
          ? null
          : {
              activationId: run.function.activationId,
              ordinal: run.function.ordinal,
            },
      })),
    };
  }

  private copyState(
    state: DylinkForkArchiveSnapshot,
  ): DylinkForkArchiveSnapshot {
    return {
      generation: state.generation,
      tableStateRoot: state.tableStateRoot,
      tableCheckpointGeneration: state.tableCheckpointGeneration,
      tablePatches: state.tablePatches.map((patch) =>
        this.copyTablePatch(patch)
      ),
      nextHandle: state.nextHandle,
      libraries: state.libraries.map((library) => this.copyLibrary(library)),
      ...(state.transactions === undefined || state.transactions.length === 0
        ? {}
        : {
            transactions: state.transactions.map((transaction) =>
              this.copyTransaction(transaction)
            ),
          }),
    };
  }
}
