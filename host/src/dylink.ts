/**
 * WebAssembly dynamic linking support — parses the dylink.0 custom section
 * and loads side modules into a running process's memory space.
 *
 * Follows the WebAssembly tool-conventions dynamic linking ABI:
 * https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md
 */

import {
  ABI_VERSION,
  WPK_FORK_CAPABILITIES_SECTION,
  WPK_FORK_CAPABILITIES_VERSION,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  WPK_FORK_CAP_DYLINK_MAIN,
  WPK_FORK_CAP_KNOWN_MASK,
  WPK_FORK_CAP_SIDE_ENTRY,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
} from "./generated/abi";
import {
  describeWasmForkArtifactContractFailures,
  extractAbiVersion,
  readWasmFunctionImports,
  type WasmFunctionImportType,
} from "./constants";
import {
  FORK_UNWIND_TAG_IMPORT_MODULE,
  FORK_UNWIND_TAG_IMPORT_NAME,
  requireForkUnwindTag,
} from "./fork-unwind-transport";

// dylink.0 sub-section types
const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;
const WASM_DYLINK_EXPORT_INFO = 3;
const WASM_DYLINK_IMPORT_INFO = 4;

// Export/import flags
const WASM_DYLINK_FLAG_TLS = 0x01;
const WASM_DYLINK_FLAG_WEAK = 0x02;

export const SIDE_MODULE_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(
  ({ name }) => name,
);
const SIDE_MODULE_FORK_EXPORT_SET: ReadonlySet<string> =
  new Set(SIDE_MODULE_FORK_EXPORTS);

function isForkRuntimeExport(name: string): boolean {
  return SIDE_MODULE_FORK_EXPORT_SET.has(name);
}

export const FORK_CAPABILITIES_SECTION = WPK_FORK_CAPABILITIES_SECTION;
export const FORK_CAPABILITIES_VERSION = WPK_FORK_CAPABILITIES_VERSION;
export const FORK_CAP_SIDE_ENTRY = WPK_FORK_CAP_SIDE_ENTRY;
export const FORK_CAP_DYLINK_MAIN = WPK_FORK_CAP_DYLINK_MAIN;
export const FORK_CAP_ACTIVATION_STATE_SAFE = WPK_FORK_CAP_ACTIVATION_STATE_SAFE;
const FORK_CAP_KNOWN_MASK = WPK_FORK_CAP_KNOWN_MASK;
export const FORK_CAPABILITIES_REQUIRED_ABI = 17;

export interface ForkInstrumentCapabilityClaim {
  /** False for an ABI-16 artifact built before role markers were introduced. */
  present: boolean;
  flags: number;
}

/** Read and validate the explicit call-graph claims emitted by the tool. */
export function readForkInstrumentCapabilityClaim(
  module: WebAssembly.Module,
): ForkInstrumentCapabilityClaim {
  const sections = WebAssembly.Module.customSections(module, FORK_CAPABILITIES_SECTION);
  if (sections.length === 0) return { present: false, flags: 0 };
  if (sections.length !== 1) {
    throw new Error(`duplicate ${FORK_CAPABILITIES_SECTION} custom sections`);
  }
  const data = new Uint8Array(sections[0]!);
  if (data.length !== 2) {
    throw new Error(`malformed ${FORK_CAPABILITIES_SECTION} custom section`);
  }
  if (data[0] !== FORK_CAPABILITIES_VERSION) {
    throw new Error(
      `unsupported fork-instrument capability version ${data[0]}; ` +
        `expected ${FORK_CAPABILITIES_VERSION}`,
    );
  }
  if ((data[1]! & ~FORK_CAP_KNOWN_MASK) !== 0) {
    throw new Error(`unknown fork-instrument capability flags 0x${data[1]!.toString(16)}`);
  }
  return { present: true, flags: data[1]! };
}

/** Return just the validated flags for callers that do not need presence. */
export function readForkInstrumentCapabilities(module: WebAssembly.Module): number {
  return readForkInstrumentCapabilityClaim(module).flags;
}

/**
 * Decide whether an artifact may serve one fork-instrument role.
 *
 * ABI 16 predates role markers, so an absent section falls back to the legacy
 * five-export contract. ABI 17 makes the role claim mandatory. A marker that
 * is present is always authoritative, including during ABI 16 migration.
 */
export function forkInstrumentRoleAvailable(
  claim: ForkInstrumentCapabilityClaim,
  roleFlag: number,
  abiVersion: number = ABI_VERSION,
): boolean {
  if (claim.present) return (claim.flags & roleFlag) !== 0;
  return abiVersion < FORK_CAPABILITIES_REQUIRED_ABI;
}

export interface DylinkMetadata {
  /** Bytes of linear memory this module needs */
  memorySize: number;
  /** Memory alignment as power of 2 */
  memoryAlign: number;
  /** Number of indirect function table slots needed */
  tableSize: number;
  /** Table alignment as power of 2 */
  tableAlign: number;
  /** Dependent shared libraries (like ELF DT_NEEDED) */
  neededDynlibs: string[];
  /** Exports that are TLS-related */
  tlsExports: Set<string>;
  /** Imports that are weakly bound */
  weakImports: Set<string>;
}

/** Read a LEB128 unsigned integer from a DataView. */
function readVarUint(data: Uint8Array, offset: { value: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[offset.value++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0; // Ensure unsigned
}

/** Read a UTF-8 string (length-prefixed) from a byte array. */
function readString(data: Uint8Array, offset: { value: number }): string {
  const len = readVarUint(data, offset);
  const bytes = data.subarray(offset.value, offset.value + len);
  offset.value += len;
  return new TextDecoder().decode(bytes);
}

/**
 * Reject automatic linear-memory writes before instantiating over a borrow.
 *
 * wasm-ld side modules use passive data plus a guarded start function. An
 * arbitrary active data segment would instead write imported Memory inside
 * WebAssembly.Instance(), before JavaScript can recover from the mutation.
 * The source module has already passed engine validation, so this parser only
 * distinguishes the standardized data-segment encodings.
 */
function requirePassiveDataSegmentsForBorrowedReplay(
  wasmBytes: Uint8Array,
  name: string,
): void {
  const offset = { value: 8 };
  while (offset.value < wasmBytes.length) {
    const sectionId = wasmBytes[offset.value++]!;
    const sectionSize = readVarUint(wasmBytes, offset);
    const sectionEnd = offset.value + sectionSize;
    if (sectionId !== 11) {
      offset.value = sectionEnd;
      continue;
    }
    const count = readVarUint(wasmBytes, offset);
    for (let index = 0; index < count; index++) {
      const flags = readVarUint(wasmBytes, offset);
      if (flags !== 1) {
        throw new Error(
          `${name}: borrowed replay requires passive data segments; `
          + `segment ${index} has flags ${flags}`,
        );
      }
      const length = readVarUint(wasmBytes, offset);
      offset.value += length;
    }
    if (offset.value !== sectionEnd) {
      throw new Error(`${name}: malformed data section during borrowed replay`);
    }
    return;
  }
}

/**
 * Remove only wasm-ld's recognized memory-initialization start section.
 *
 * WHY: start executes during WebAssembly.Instance() and can write the
 * suspended parent's live Memory. Complete fork replay reconstructs fresh
 * instance globals from ABI 43 state and already owns the parent's initialized
 * bytes, so wasm-ld's exported `__wasm_init_memory` start is unnecessary. An
 * arbitrary start is rejected rather than silently changing its semantics.
 */
function withoutBorrowedReplayStart(
  wasmBytes: Uint8Array,
  name: string,
): Uint8Array {
  const retained: Uint8Array[] = [wasmBytes.subarray(0, 8)];
  const offset = { value: 8 };
  let retainedLength = 8;
  let startFunctionIndex: number | undefined;
  let wasmLdInitFunctionIndex: number | undefined;
  while (offset.value < wasmBytes.length) {
    const sectionStart = offset.value;
    const sectionId = wasmBytes[offset.value++]!;
    const sectionSize = readVarUint(wasmBytes, offset);
    const sectionEnd = offset.value + sectionSize;
    if (sectionId === 8) {
      startFunctionIndex = readVarUint(wasmBytes, offset);
      if (offset.value !== sectionEnd) {
        throw new Error(`${name}: malformed start section during borrowed replay`);
      }
    } else {
      const section = wasmBytes.subarray(sectionStart, sectionEnd);
      retained.push(section);
      retainedLength += section.length;
      if (sectionId === 7) {
        const exportOffset = { value: offset.value };
        const exportCount = readVarUint(wasmBytes, exportOffset);
        for (let index = 0; index < exportCount; index++) {
          const exportName = readString(wasmBytes, exportOffset);
          const kind = wasmBytes[exportOffset.value++]!;
          const exportIndex = readVarUint(wasmBytes, exportOffset);
          if (exportName === "__wasm_init_memory" && kind === 0) {
            wasmLdInitFunctionIndex = exportIndex;
          }
        }
      }
    }
    offset.value = sectionEnd;
  }
  if (startFunctionIndex === undefined) return wasmBytes;
  if (startFunctionIndex !== wasmLdInitFunctionIndex) {
    throw new Error(
      `${name}: borrowed replay cannot suppress unrecognized start function `
      + `${startFunctionIndex}; expected exported __wasm_init_memory`,
    );
  }
  const result = new Uint8Array(retainedLength);
  let writeOffset = 0;
  for (const section of retained) {
    result.set(section, writeOffset);
    writeOffset += section.length;
  }
  return result;
}

/**
 * Parse the dylink.0 custom section from a Wasm binary.
 * Returns null if the section is not found.
 */
export function parseDylinkSection(wasmBytes: Uint8Array): DylinkMetadata | null {
  // Wasm magic + version = 8 bytes
  if (wasmBytes.length < 8) return null;
  if (wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 ||
      wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) {
    return null; // Not a Wasm binary
  }

  const offset = { value: 8 };

  // The dylink.0 section must be the very first section
  if (offset.value >= wasmBytes.length) return null;

  const sectionId = wasmBytes[offset.value++];
  if (sectionId !== 0) return null; // Must be a custom section (id=0)

  const sectionSize = readVarUint(wasmBytes, offset);
  const sectionEnd = offset.value + sectionSize;

  // Read custom section name
  const name = readString(wasmBytes, offset);
  if (name !== "dylink.0") return null;

  const metadata: DylinkMetadata = {
    memorySize: 0,
    memoryAlign: 0,
    tableSize: 0,
    tableAlign: 0,
    neededDynlibs: [],
    tlsExports: new Set(),
    weakImports: new Set(),
  };

  // Parse sub-sections
  while (offset.value < sectionEnd) {
    const subType = readVarUint(wasmBytes, offset);
    const subSize = readVarUint(wasmBytes, offset);
    const subEnd = offset.value + subSize;

    switch (subType) {
      case WASM_DYLINK_MEM_INFO:
        metadata.memorySize = readVarUint(wasmBytes, offset);
        metadata.memoryAlign = readVarUint(wasmBytes, offset);
        metadata.tableSize = readVarUint(wasmBytes, offset);
        metadata.tableAlign = readVarUint(wasmBytes, offset);
        break;

      case WASM_DYLINK_NEEDED: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          metadata.neededDynlibs.push(readString(wasmBytes, offset));
        }
        break;
      }

      case WASM_DYLINK_EXPORT_INFO: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          const symName = readString(wasmBytes, offset);
          const flags = readVarUint(wasmBytes, offset);
          if (flags & WASM_DYLINK_FLAG_TLS) {
            metadata.tlsExports.add(symName);
          }
        }
        break;
      }

      case WASM_DYLINK_IMPORT_INFO: {
        const count = readVarUint(wasmBytes, offset);
        for (let i = 0; i < count; i++) {
          const _module = readString(wasmBytes, offset);
          const field = readString(wasmBytes, offset);
          const flags = readVarUint(wasmBytes, offset);
          if (flags & WASM_DYLINK_FLAG_WEAK) {
            metadata.weakImports.add(field);
          }
        }
        break;
      }

      default:
        // Skip unknown sub-sections
        break;
    }

    offset.value = subEnd;
  }

  return metadata;
}

/**
 * Return function exports whose indices refer to module-defined functions.
 *
 * WebAssembly.Module.exports() exposes only names and kinds. Dynamic-linker
 * self-import handling also needs the function index: an imported function can
 * be re-exported under the same name, but that is not a local definition and
 * must not receive a trampoline back to itself.
 *
 * `module` has already validated the binary before this helper is called, so
 * section bounds and LEB encodings are known to be structurally valid.
 */
function readDefinedFunctionExports(
  wasmBytes: Uint8Array,
  importedFunctionCount: number,
): Set<string> {
  const result = new Set<string>();
  const offset = { value: 8 };
  while (offset.value < wasmBytes.length) {
    const sectionId = wasmBytes[offset.value++];
    const sectionSize = readVarUint(wasmBytes, offset);
    const sectionEnd = offset.value + sectionSize;
    if (sectionId !== 7) {
      offset.value = sectionEnd;
      continue;
    }

    const exportCount = readVarUint(wasmBytes, offset);
    for (let i = 0; i < exportCount; i++) {
      const name = readString(wasmBytes, offset);
      const kind = wasmBytes[offset.value++];
      const index = readVarUint(wasmBytes, offset);
      if (kind === 0 && index >= importedFunctionCount) result.add(name);
    }
    break;
  }
  return result;
}

/** Align a value up to the given alignment (must be power of 2). */
function alignUp(value: number, align: number): number {
  return (value + align - 1) & ~(align - 1);
}

type WasmAddress = number | bigint;

interface AddressedTable {
  readonly length: WasmAddress;
  grow(delta: WasmAddress): WasmAddress;
  get(index: WasmAddress): Function | null;
  set(index: WasmAddress, value: Function | null): void;
}

interface AddressedMemory {
  grow(delta: WasmAddress): WasmAddress;
}

function wasmAddress(value: number, ptrWidth: 4 | 8, context: string): WasmAddress {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${context}: address is not an exact non-negative integer`);
  }
  return ptrWidth === 8 ? BigInt(value) : value;
}

function requireWasmAddress(
  value: WasmAddress,
  ptrWidth: 4 | 8,
  context: string,
): WasmAddress {
  const expectedType = ptrWidth === 8 ? "bigint" : "number";
  if (typeof value !== expectedType) {
    throw new TypeError(`${context}: expected a ${ptrWidth * 8}-bit WebAssembly address`);
  }
  if (
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    || (typeof value === "bigint" && value < 0n)
  ) {
    throw new RangeError(`${context}: address is not an exact non-negative integer`);
  }
  return value;
}

function copyForkMemoryAllocation(
  allocation: DylinkForkMemoryAllocation,
  context: string,
): DylinkForkMemoryAllocation {
  const fields = [
    ["address", allocation.address],
    ["size", allocation.size],
    ["mapping address", allocation.mappingAddress],
    ["mapping size", allocation.mappingSize],
  ] as const;
  for (const [field, value] of fields) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${context}: ${field} is not an exact positive integer`);
    }
  }
  const logicalEnd = allocation.address + allocation.size;
  const mappingEnd = allocation.mappingAddress + allocation.mappingSize;
  if (
    !Number.isSafeInteger(logicalEnd)
    || !Number.isSafeInteger(mappingEnd)
    || allocation.address < allocation.mappingAddress
    || logicalEnd > mappingEnd
  ) {
    throw new RangeError(`${context}: logical allocation escapes its process mapping`);
  }
  return Object.freeze({
    address: allocation.address,
    size: allocation.size,
    mappingAddress: allocation.mappingAddress,
    mappingSize: allocation.mappingSize,
  });
}

function tableAddress(
  table: WebAssembly.Table,
  value: number,
  context: string,
): WasmAddress {
  const rawLength = (table as unknown as AddressedTable).length;
  const tableWidth = typeof rawLength === "bigint" ? 8 : 4;
  return wasmAddress(value, tableWidth, context);
}

function tableLength(table: WebAssembly.Table): number {
  const rawLength = (table as unknown as AddressedTable).length;
  const tableWidth = typeof rawLength === "bigint" ? 8 : 4;
  requireWasmAddress(rawLength, tableWidth, "dynamic-linker table length");
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) {
    throw new RangeError("dynamic-linker table length exceeds JavaScript's exact integer range");
  }
  return length;
}

function growTable(table: WebAssembly.Table, delta: number): void {
  const addressed = table as unknown as AddressedTable;
  addressed.grow(tableAddress(table, delta, "dynamic-linker table growth"));
}

function getTableEntry(
  table: WebAssembly.Table,
  index: number,
): Function | null {
  return (table as unknown as AddressedTable).get(
    tableAddress(table, index, "dynamic-linker table index"),
  );
}

function setTableEntry(
  table: WebAssembly.Table,
  index: number,
  value: Function | null,
): void {
  (table as unknown as AddressedTable).set(
    tableAddress(table, index, "dynamic-linker table index"),
    value,
  );
}

function growMemory(memory: WebAssembly.Memory, delta: number, ptrWidth: 4 | 8): void {
  (memory as unknown as AddressedMemory).grow(
    wasmAddress(delta, ptrWidth, "dynamic-linker memory growth"),
  );
}

/**
 * Shared library instance loaded into a process's address space.
 */
export interface DylinkForkMemoryAllocation {
  /** Aligned address returned to the side module. */
  readonly address: number;
  /** Logical byte count requested by the side module. */
  readonly size: number;
  /** Exact mmap base owned by the process allocator. */
  readonly mappingAddress: number;
  /** Exact mmap byte count that must be passed to munmap. */
  readonly mappingSize: number;
}

export interface LoadedSharedLibrary {
  /** Wasm module instance */
  instance: WebAssembly.Instance;
  /** Base address in linear memory where this library's data is placed */
  memoryBase: number;
  /** Base index in the indirect function table */
  tableBase: number;
  /** Exported symbols (functions and data addresses) */
  exports: Record<string, WebAssembly.ExportValue>;
  /** Metadata from dylink.0 */
  metadata: DylinkMetadata;
  /** Path/name of the library */
  name: string;
  /** Immutable loader-owned snapshot used by dependency-first fork archives. */
  moduleBytes: Uint8Array;
  /** Stable process activation coordinate persisted in the dlopen archive. */
  activationId?: number;
  /**
   * Exact process-table entries whose callable values belong to this module.
   *
   * Table length cannot shrink, so final unload clears these slots to null.
   * Gaps stay addressable and a later archive preserves their positions.
   */
  ownedTableEntries: readonly number[];
  /** GOT cells consumed by this module, with their exact symbol kind. */
  gotImports: readonly Readonly<{
    name: string;
    kind: "mem" | "func";
  }>[];
  /** Release the registered activation exactly once on final unload. */
  unregisterForkActivation?: () => void;
  /** Thread-local-storage base captured from the parent instance. */
  tlsBase?: number;
  /** Provisional objects are visible to nested loader transactions. */
  loadState?: "initializing" | "loaded";
  /** Whether this object contributes exports to the RTLD_DEFAULT scope. */
  globalVisibility: boolean;
  /**
   * True when a completed RTLD_GLOBAL dlopen selected this object as its root.
   *
   * WHY: an outer constructor can promote a pre-existing LOCAL closure and
   * then fail after a nested, independently committed GLOBAL open. Rollback
   * must undo only the outer promotion and reapply the surviving root.
   */
  committedGlobalRoot?: boolean;
  /** Present only while libc owns an issued loader entry. */
  initialization?: Readonly<{
    transactionToken: number;
    stage: DylinkInitializationStage;
    tableIndex: number;
  }>;
  /** Other side modules whose symbols this instance captured while linking. */
  providerDependencies?: ReadonlySet<string>;
  /** Process mappings owned until rollback or final unload. */
  allocations?: readonly DylinkForkMemoryAllocation[];
  /** Standalone-linker heap high-water mark owned by this object. */
  heapReservationEnd?: number;
}

export interface DylinkForkActivationRequest {
  readonly name: string;
  readonly module: WebAssembly.Module;
  readonly moduleBytes: Uint8Array;
  /** Exact archived coordinate in a fresh fork child; absent in the parent. */
  readonly replayActivationId?: number;
}

/**
 * One pre-instantiation reservation from the process activation coordinator.
 *
 * `env` owns every fork/frame/module/reference/exception/GC import, including
 * `fork` itself. The loader only binds those values; it does not keep a
 * module-local continuation or infer which activation is currently active.
 */
export interface PreparedDylinkForkActivation {
  readonly activationId: number;
  readonly env: Readonly<Record<string, WebAssembly.ImportValue>>;
  /**
   * Wrap the loader's final lazy import object immediately before
   * instantiation. Imported-global/table ownership observes the engine's exact
   * property reads, including duplicate `(module, name)` declarations.
   */
  wrapImports(imports: WebAssembly.Imports): WebAssembly.Imports;
  register(instance: WebAssembly.Instance): void;
  unregister(): void;
}

export interface DylinkForkActivationOwner {
  prepare(request: DylinkForkActivationRequest): PreparedDylinkForkActivation;
}

/** Compact live linker state persisted by the process fork archive. */
export interface DylinkForkLibraryState {
  readonly name: string;
  /** Loader-owned immutable-by-contract artifact snapshot. */
  readonly moduleBytes: Readonly<Uint8Array>;
  readonly memoryBase: number;
  readonly tableBase: number;
  readonly activationId?: number;
  readonly tlsBase?: number;
  readonly globalVisibility: boolean;
  readonly committedGlobalRoot?: boolean;
  /**
   * Runtime symbol providers captured outside immutable DT_NEEDED edges.
   *
   * Constructor dlsym calls are not re-executed in a fresh child, so their
   * lifetime edges must be explicit reconstruction data.
   */
  readonly providerDependencies?: readonly string[];
  /**
   * Exact allocator ownership copied into a fork child.
   *
   * The child's linear memory and kernel mmap map are copied, but its Worker
   * has fresh JavaScript bookkeeping. These recipes reconnect the two without
   * issuing a second mmap or guessing the allocator's alignment padding.
   */
  readonly allocations?: readonly DylinkForkMemoryAllocation[];
  /** Absent when the module is live only as a NEEDED dependency. */
  readonly handle?: number;
  /** Present exactly when `handle` is present. */
  readonly refCount?: number;
  /** Durable continuation point for one libc-driven initialization call. */
  readonly initialization?: Readonly<{
    transactionToken: number;
    stage: DylinkInitializationStage;
    tableIndex: number;
  }>;
}

export interface DylinkForkTransactionState {
  readonly token: number;
  readonly name: string;
  readonly moduleBytes: Readonly<Uint8Array>;
  readonly globalVisibility: boolean;
}

export interface DylinkForkState {
  readonly nextHandle: number;
  /** Dependency-first `loadedLibraries` insertion order. */
  readonly libraries: readonly DylinkForkLibraryState[];
  /** Outer-to-inner loader transactions stopped in ordinary Wasm calls. */
  readonly transactions?: readonly DylinkForkTransactionState[];
}

export interface DylinkForkPublishedState extends DylinkForkState {
  /** Monotonic archive publication observed under the process reader lock. */
  readonly generation: number;
}

interface PendingDlopenTransaction {
  readonly token: number;
  readonly name: string;
  readonly moduleBytes: Uint8Array;
  readonly globalVisibility: boolean;
  readonly steps: Generator<
    DylinkInitializationStep,
    LoadedSharedLibrary,
    DylinkForkLibraryState | undefined
  >;
  /**
   * Mutable view captured by `loadSharedLibrarySyncSteps`.
   *
   * A replica may first observe a dependency initializer and only learn the
   * root module's exact layout in a later archive generation. Updating this
   * map lets the suspended generator consume that later reconstruction recipe
   * without allocating a Worker-local layout.
   */
  readonly replayModules?: Map<string, DylinkForkLibraryState>;
  readonly initialLibraries: ReadonlySet<LoadedSharedLibrary>;
  readonly initialVisibility: ReadonlyMap<LoadedSharedLibrary, boolean>;
  readonly ownedLibraries: Set<LoadedSharedLibrary>;
  readonly initialHeapPointer?: number;
  tableIndex?: number;
  awaitingCompletion: boolean;
  currentStep?: DylinkInitializationStep;
  loaded?: LoadedSharedLibrary;
}

/**
 * Options used when re-instantiating a side module in a fork child.
 *
 * Preconditions:
 *   - Replay must run in the same order as the parent's original dlopens.
 *     Each entry supplies the parent's exact `__table_base`; replay may pad
 *     null gaps up to that base but rejects a child table that already grew
 *     past it (an interleaved dlsym, future GOT preallocation, etc.).
 *   - `options.loadedLibraries` must NOT already contain `name`. Replay
 *     rejects duplicate module-load records before mutating linker state.
 *   - Every `dylink.0` NEEDED dependency must already have been replayed from
 *     its own earlier archive entry.
 */
export interface DylinkReplayOptions {
  /** Memory base returned by the parent's allocator. Data relocations in
   *  the memcpy'd data section encode (memoryBase + offset); using any
   *  other base corrupts pointers. */
  memoryBase: number;
  /** Exact table base observed in the parent, including failed-load gaps. */
  tableBase: number;
  /** Exact stable activation coordinate copied from the fork parent. */
  activationId?: number;
  /** Exact mutable `__tls_base` value from the fork parent. The child memory
   *  already contains the parent's live TLS bytes, so replay restores only
   *  this instance-local global and deliberately does not call
   *  `__wasm_init_tls`, which would reset those bytes to the initial image. */
  tlsBase?: number;
  /** Rebuild a generator stopped before this direct libc table call. */
  initializationStage?: DylinkInitializationStage;
  /** Exact RTLD visibility of the parent object. */
  globalVisibility?: boolean;
  /** Whether this object is the root of a committed RTLD_GLOBAL open. */
  committedGlobalRoot?: boolean;
  /** Exact runtime provider edges already established in the parent. */
  providerDependencies?: readonly string[];
  /** Exact live mapping ownership copied from the parent process. */
  allocations?: readonly DylinkForkMemoryAllocation[];
  /**
   * A borrowed vfork replay shares the suspended parent's linear Memory.
   * Loader-controlled instantiation must therefore be provably read-only.
   */
  memoryOwnership?: "copied" | "borrowed";
}

export interface DylinkForkReconcileOptions {
  readonly memoryOwnership?: "copied" | "borrowed";
}

/**
 * Options for loading a shared library.
 */
export interface LoadSharedLibraryOptions {
  /** The shared Wasm.Memory used by the process */
  memory: WebAssembly.Memory;
  /** The process's indirect function table */
  table: WebAssembly.Table;
  /** Stack pointer global (shared across all modules) */
  stackPointer: WebAssembly.Global;
  /** Current heap pointer — updated after allocation when no allocator is supplied */
  heapPointer?: { value: number };
  /** Allocate side-module linear-memory data in the process address space */
  allocateMemory?: (size: number, align: number) => number;
  /**
   * Describe the exact mapping behind an aligned allocateMemory result.
   *
   * Process Workers use this to persist raw mmap ownership for fresh-Worker
   * replay. Embedders whose allocator/deallocator use the logical range may
   * omit it.
   */
  describeMemoryAllocation?: (
    address: number,
    size: number,
  ) => Readonly<{ mappingAddress: number; mappingSize: number }>;
  /** Adopt copied mapping ownership without allocating new process memory. */
  adoptMemoryAllocation?: (allocation: DylinkForkMemoryAllocation) => void;
  /** Drop Worker-local ownership after another pthread published the unload. */
  forgetMemoryAllocation?: (allocation: DylinkForkMemoryAllocation) => void;
  /** Release a successful allocateMemory result when loading rolls back. */
  deallocateMemory?: (addr: number, size: number) => void;
  /** Global symbol table: name → function or WebAssembly.Global */
  globalSymbols: Map<string, Function | WebAssembly.Global>;
  /** Defining side module for each global symbol; absent means the main image. */
  globalSymbolOwners?: Map<string, string | undefined>;
  /** GOT entries: symbol name → mutable pointer-width WebAssembly.Global */
  got: Map<string, WebAssembly.Global>;
  /** Internal exact type of every live GOT cell. */
  gotKinds?: Map<string, "mem" | "func">;
  /** Already-loaded libraries for dedup and dependency resolution */
  loadedLibraries: Map<string, LoadedSharedLibrary>;
  /**
   * Process-owned exception tag shared by the main image and every side
   * module. When omitted, standalone linker users get one tag lazily and it
   * is retained on this options object for subsequent loads.
   */
  longjmpTag?: WebAssembly.Tag;
  /**
   * Process-owned C++ exception tag shared by every C++ side module. C++
   * exceptions crossing side-module calls require tag identity as well as a
   * matching payload type, so this must not be allocated per dlopen.
   */
  cppExceptionTag?: WebAssembly.Tag;
  /**
   * Private unwind transport shared by the main image and every instrumented
   * side module in this process Worker.
   */
  forkUnwindTag?: WebAssembly.Tag;
  /** Process pointer width, which also determines the __c_longjmp payload. */
  ptrWidth?: 4 | 8;
  /** Process owner for every ABI-43 side-module activation. */
  forkActivationOwner?: DylinkForkActivationOwner;
  /** Precise rebuild/boundary diagnostic when the owner is unavailable. */
  forkActivationOwnerUnavailableReason?: string;
  /**
   * Journal host-created function-table entries (currently dlsym of a main
   * export) into the same activation-owned sparse table state as Wasm writes.
   */
  onTableMutation?: (
    table: WebAssembly.Table,
    firstIndex: number,
    length: number,
  ) => void;
  /**
   * Route the exact final function import through the process Worker owner.
   * This runs at Proxy property resolution so duplicate declarations and
   * activation-owned exception identities are not collapsed eagerly.
   */
  routeFunctionImport?: (
    imported: WasmFunctionImportType,
    localImplementation: CallableFunction,
  ) => CallableFunction;
  /** Callback to locate a dependency relative to its requesting object. */
  resolveLibrary?: (
    name: string,
    requester?: string,
  ) => Promise<Uint8Array | null>;
  /** Synchronous dependency resolver used by guest dlopen(). */
  resolveLibrarySync?: (
    name: string,
    requester?: string,
  ) => Uint8Array | null;
}

interface DylinkLoadContext {
  readonly ownedLibraries: Set<LoadedSharedLibrary>;
}

function symbolOwners(
  options: LoadSharedLibraryOptions,
): Map<string, string | undefined> {
  options.globalSymbolOwners ??= new Map(
    Array.from(options.globalSymbols.keys(), (name) => [name, undefined]),
  );
  return options.globalSymbolOwners;
}

function functionTableIndex(
  options: LoadSharedLibraryOptions,
  fn: Function,
): number | undefined {
  const length = tableLength(options.table);
  for (let index = 0; index < length; index++) {
    if (getTableEntry(options.table, index) === fn) return index;
  }
  return undefined;
}

function isPublicDylinkExport(
  name: string,
  value: WebAssembly.ExportValue,
): value is Function | WebAssembly.Global {
  return (
    !name.startsWith("__")
    && !isForkRuntimeExport(name)
    && (
      typeof value === "function"
      || value instanceof WebAssembly.Global
    )
  );
}

function publishGlobalLibrarySymbols(
  library: LoadedSharedLibrary,
  options: LoadSharedLibraryOptions,
): void {
  if (!library.globalVisibility) return;
  const owners = symbolOwners(options);
  for (const [name, value] of Object.entries(library.exports)) {
    if (
      !isPublicDylinkExport(name, value)
      || options.globalSymbols.has(name)
    ) {
      continue;
    }
    options.globalSymbols.set(name, value);
    owners.set(name, library.name);
  }
}

function promoteLibraryGlobal(
  library: LoadedSharedLibrary,
  options: LoadSharedLibraryOptions,
  visited = new Set<string>(),
): void {
  if (visited.has(library.name)) return;
  visited.add(library.name);
  for (const dependencyName of library.metadata.neededDynlibs) {
    const dependency = options.loadedLibraries.get(dependencyName);
    if (!dependency) {
      throw new Error(
        `${library.name}: loaded dependency ${dependencyName} is missing during promotion`,
      );
    }
    promoteLibraryGlobal(dependency, options, visited);
  }
  library.globalVisibility = true;
  publishGlobalLibrarySymbols(library, options);
}

function appendDependencyScope(
  scope: LoadedSharedLibrary[],
  roots: readonly LoadedSharedLibrary[],
  options: LoadSharedLibraryOptions,
): void {
  const seen = new Set(scope.map((library) => library.name));
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const library = queue[index]!;
    if (seen.has(library.name)) continue;
    seen.add(library.name);
    scope.push(library);
    for (const dependencyName of library.metadata.neededDynlibs) {
      const dependency = options.loadedLibraries.get(dependencyName);
      if (!dependency) {
        throw new Error(
          `${library.name}: loaded dependency ${dependencyName} is missing`,
        );
      }
      if (!seen.has(dependency.name)) queue.push(dependency);
    }
  }
}

function runtimeDependencyNames(
  library: LoadedSharedLibrary,
): ReadonlySet<string> {
  const dependencies = new Set([
    ...library.metadata.neededDynlibs,
    ...(library.providerDependencies ?? []),
  ]);
  dependencies.delete(library.name);
  return dependencies;
}

function scopedSymbol(
  options: LoadSharedLibraryOptions,
  dependencyScope: readonly LoadedSharedLibrary[],
  name: string,
): Readonly<{
  value: Function | WebAssembly.Global;
  owner?: string;
}> | undefined {
  const global = options.globalSymbols.get(name);
  if (global !== undefined) {
    return { value: global, owner: symbolOwners(options).get(name) };
  }
  for (const dependency of dependencyScope) {
    const value = dependency.exports[name];
    if (
      typeof value === "function"
      || value instanceof WebAssembly.Global
    ) {
      return { value, owner: dependency.name };
    }
  }
  return undefined;
}

function refreshGlobalGotEntries(options: LoadSharedLibraryOptions): void {
  const ptrWidth = options.ptrWidth ?? 4;
  for (const [name, entry] of options.got) {
    const kind = options.gotKinds?.get(name);
    if (!kind) continue;
    const symbol = options.globalSymbols.get(name);
    if (kind === "mem" && symbol instanceof WebAssembly.Global) {
      entry.value = requireWasmAddress(
        symbol.value as WasmAddress,
        ptrWidth,
        `GOT.mem.${name}`,
      );
      continue;
    }
    if (kind === "func" && typeof symbol === "function") {
      const index = functionTableIndex(options, symbol);
      entry.value = wasmAddress(
        index ?? 0,
        ptrWidth,
        `GOT.func.${name}`,
      );
      continue;
    }
    entry.value = wasmAddress(0, ptrWidth, `unresolved GOT.${kind}.${name}`);
  }
}

function requireNonzeroU32(value: number, context: string): number {
  if (
    !Number.isInteger(value)
    || value <= 0
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${context} is not a nonzero u32`);
  }
  return value;
}

type TagConstructor = new (
  descriptor: { parameters: Array<"i32" | "i64"> },
) => WebAssembly.Tag;

function tagConstructor(): TagConstructor | undefined {
  return (WebAssembly as typeof WebAssembly & { Tag?: TagConstructor }).Tag;
}

/** Create the exception tag used by one process and all of its side modules. */
export function createLongjmpTag(ptrWidth: 4 | 8): WebAssembly.Tag | undefined {
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid process pointer width ${String(ptrWidth)}`);
  }
  const Tag = tagConstructor();
  return Tag
    ? new Tag({ parameters: [ptrWidth === 8 ? "i64" : "i32"] })
    : undefined;
}

/** Create the process-owned C++ exception tag for the target pointer width. */
export function createCppExceptionTag(ptrWidth: 4 | 8): WebAssembly.Tag | undefined {
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid process pointer width ${String(ptrWidth)}`);
  }
  const Tag = tagConstructor();
  return Tag
    ? new Tag({ parameters: [ptrWidth === 8 ? "i64" : "i32"] })
    : undefined;
}

/** Reject lookalike values before handing an exception-tag import to Wasm. */
export function requireLongjmpTag(value: unknown, context: string): WebAssembly.Tag {
  const Tag = tagConstructor();
  if (!Tag) {
    throw new Error(`${context}: this WebAssembly runtime does not support exception tags`);
  }
  if (!(value instanceof Tag)) {
    throw new TypeError(`${context}: __c_longjmp must be an actual WebAssembly.Tag`);
  }
  return value;
}

/** Reject lookalike values before handing the C++ tag import to Wasm. */
export function requireCppExceptionTag(value: unknown, context: string): WebAssembly.Tag {
  const Tag = tagConstructor();
  if (!Tag) {
    throw new Error(`${context}: this WebAssembly runtime does not support exception tags`);
  }
  if (!(value instanceof Tag)) {
    throw new TypeError(`${context}: __cpp_exception must be an actual WebAssembly.Tag`);
  }
  return value;
}

function validateLongjmpConfiguration(options: LoadSharedLibraryOptions): void {
  const ptrWidth = options.ptrWidth ?? 4;
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new TypeError(`invalid process pointer width ${String(ptrWidth)}`);
  }
  if (options.longjmpTag !== undefined) {
    requireLongjmpTag(options.longjmpTag, "dynamic linker");
  }
}

function resolveLongjmpTag(options: LoadSharedLibraryOptions): WebAssembly.Tag {
  validateLongjmpConfiguration(options);
  if (options.longjmpTag !== undefined) return options.longjmpTag;
  const ptrWidth = options.ptrWidth ?? 4;
  const tag = createLongjmpTag(ptrWidth);
  options.longjmpTag = requireLongjmpTag(tag, "dynamic linker");
  return options.longjmpTag;
}

function resolveCppExceptionTag(options: LoadSharedLibraryOptions): WebAssembly.Tag {
  validateLongjmpConfiguration(options);
  if (options.cppExceptionTag !== undefined) {
    return requireCppExceptionTag(options.cppExceptionTag, "dynamic linker");
  }
  const ptrWidth = options.ptrWidth ?? 4;
  const tag = createCppExceptionTag(ptrWidth);
  options.cppExceptionTag = requireCppExceptionTag(tag, "dynamic linker");
  return options.cppExceptionTag;
}

export type DylinkInitializationStage =
  | "bootstrap"
  | "relocations"
  | "constructors";

export interface DylinkInitializationStep {
  readonly libraryName: string;
  readonly stage: DylinkInitializationStage;
  /** Exact module identity that must be publishable before `invoke` runs. */
  readonly forkState: DylinkForkLibraryState;
  /**
   * All loader-controlled guest entries have the canonical `() -> ()` shape.
   *
   * A process loader may install this exact function in its shared table and
   * let libc invoke it as an ordinary Wasm call. Standalone embedders drive
   * the same state machine synchronously.
   */
  readonly invoke: () => void;
}

/**
 * Core shared library loading logic — instantiates a pre-parsed Wasm
 * side module into the process address space. Used by both async and sync
 * entry points.
 */
function* instantiateSharedLibrarySteps(
  name: string,
  wasmBytes: Uint8Array,
  metadata: DylinkMetadata,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
  loadContext?: DylinkLoadContext,
  globalVisibility = true,
  dependencyScope: readonly LoadedSharedLibrary[] = [],
): Generator<
  DylinkInitializationStep,
  LoadedSharedLibrary,
  DylinkForkLibraryState | undefined
> {
  validateLongjmpConfiguration(options);
  const ptrWidth = options.ptrWidth ?? 4;
  const pointerGlobalType = ptrWidth === 8 ? "i64" : "i32";
  // Compile the exact archive bytes first. Besides producing clearer engine
  // diagnostics, this makes the narrow section parser below operate only on a
  // structurally valid module.
  const sourceModule = new WebAssembly.Module(
    wasmBytes as unknown as BufferSource,
  );
  const borrowsMemory = replay?.memoryOwnership === "borrowed";
  if (borrowsMemory) {
    if (!(options.memory.buffer instanceof SharedArrayBuffer)) {
      throw new Error(`${name}: borrowed replay requires Shared Memory`);
    }
    if (replay?.initializationStage !== undefined) {
      throw new Error(
        `${name}: borrowed replay cannot resume an in-flight dlopen initializer`,
      );
    }
    requirePassiveDataSegmentsForBorrowedReplay(wasmBytes, name);
  }
  const module = borrowsMemory
    ? new WebAssembly.Module(
        withoutBorrowedReplayStart(wasmBytes, name) as unknown as BufferSource,
      )
    : sourceModule;
  const moduleImports = WebAssembly.Module.imports(module);
  const moduleExports = WebAssembly.Module.exports(module);
  const moduleExportKinds = new Map(
    moduleExports.map((moduleExport) => [
      moduleExport.name,
      moduleExport.kind,
    ]),
  );
  const functionImports = readWasmFunctionImports(
    wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer,
  );
  const functionImportsByName = new Map<string, WasmFunctionImportType[]>();
  for (const imported of functionImports) {
    const key = `${imported.module.length}:${imported.module}${imported.name}`;
    const entries = functionImportsByName.get(key) ?? [];
    entries.push(imported);
    functionImportsByName.set(key, entries);
  }
  const functionImportReads = new Map<string, number>();
  const importsFork = moduleImports.some((imp) =>
    imp.module === "env" && imp.name === "fork" && imp.kind === "function"
  );
  const requiredForkFunctionImportNames = WPK_FORK_REQUIRED_IMPORTS
    .filter(({ module }) => module === "env")
    .map(({ name }) => name);
  const requiredForkFunctionImportCount =
    requiredForkFunctionImportNames.filter((importName) =>
      moduleImports.some((imp) =>
        imp.module === "env" && imp.name === importName && imp.kind === "function"
      )
    ).length;
  const presentForkExports = SIDE_MODULE_FORK_EXPORTS.filter((exportName) =>
    moduleExports.some((exp) => exp.kind === "function" && exp.name === exportName)
  );
  const hasCompleteForkInstrumentation =
    presentForkExports.length === SIDE_MODULE_FORK_EXPORTS.length;
  const forkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
  const sideEntryAvailable = forkInstrumentRoleAvailable(
    forkCapabilityClaim,
    FORK_CAP_SIDE_ENTRY,
  );
  const importedFunctionCount = moduleImports.filter((imp) => imp.kind === "function").length;
  const definedFunctionExports = readDefinedFunctionExports(
    wasmBytes,
    importedFunctionCount,
  );
  // wasm-ld can make an interposable C++ definition both an env import and a
  // module export. The main process still wins when it supplies the symbol;
  // otherwise route only this genuine self-definition back to the module.
  // Do not manufacture trampolines for arbitrary unresolved imports: those
  // remain instantiation errors instead of turning an ABI gap into a delayed
  // failure on a possibly-unexecuted path.
  const selfFunctionImports = new Set(
    moduleImports
      .filter((imp) =>
        imp.module === "env"
        && imp.kind === "function"
        && definedFunctionExports.has(imp.name)
      )
      .map((imp) => imp.name),
  );
  const importsLongjmpTag = moduleImports.some((imp) =>
    imp.module === "env"
      && imp.name === "__c_longjmp"
      && (imp.kind as string) === "tag"
  );
  const longjmpTag = importsLongjmpTag ? resolveLongjmpTag(options) : undefined;
  const importsCppExceptionTag = moduleImports.some((imp) =>
    imp.module === "env"
      && imp.name === "__cpp_exception"
      && (imp.kind as string) === "tag"
  );
  const cppExceptionTag = importsCppExceptionTag
    ? resolveCppExceptionTag(options)
    : undefined;
  const importsForkUnwindTag = moduleImports.some((imp) =>
    imp.module === FORK_UNWIND_TAG_IMPORT_MODULE
      && imp.name === FORK_UNWIND_TAG_IMPORT_NAME
      && (imp.kind as string) === "tag"
  );

  if (presentForkExports.length > 0 && !hasCompleteForkInstrumentation) {
    const missing = SIDE_MODULE_FORK_EXPORTS.filter((exportName) =>
      !moduleExports.some((exp) => exp.kind === "function" && exp.name === exportName)
    );
    throw new Error(
      `${name}: incomplete wasm-fork-instrument exports; missing ${missing.join(", ")}`,
    );
  }
  if (options.forkActivationOwner && !hasCompleteForkInstrumentation) {
    throw new Error(
      `${name}: fork-capable process requires complete ABI 43 side-boundary `
      + "instrumentation; rebuild the side module with wasm-fork-instrument",
    );
  }
  if (
    hasCompleteForkInstrumentation &&
    (
      !forkCapabilityClaim.present ||
      (forkCapabilityClaim.flags & FORK_CAP_ACTIVATION_STATE_SAFE) === 0
    )
  ) {
    throw new Error(
      `${name}: wasm-fork-instrument artifact lacks the ABI 43 ` +
      "activation-state-safe capability; rebuild the side module",
    );
  }
  if (hasCompleteForkInstrumentation) {
    const artifactBytes = wasmBytes.buffer.slice(
      wasmBytes.byteOffset,
      wasmBytes.byteOffset + wasmBytes.byteLength,
    ) as ArrayBuffer;
    const declaredAbi = extractAbiVersion(artifactBytes);
    if (declaredAbi === null) {
      throw new Error(
        `${name}: ABI 43 fork-instrumented side module is missing __abi_version; ` +
          "the activation-state capability epoch cannot be verified",
      );
    }
    if (declaredAbi !== ABI_VERSION) {
      throw new Error(
        `${name}: fork-instrumented side module declares ABI ${declaredAbi}, ` +
          `but the host requires ABI ${ABI_VERSION}`,
      );
    }
    const contractFailures =
      describeWasmForkArtifactContractFailures(artifactBytes);
    if (contractFailures.length > 0) {
      throw new Error(
        `${name}: invalid ABI 43 fork reconstruction contract: ` +
          contractFailures.join("; "),
      );
    }
  }
  if (importsFork && !hasCompleteForkInstrumentation) {
    throw new Error(
      `${name}: env.fork requires complete side-module instrumentation; ` +
        "rebuild with wasm-fork-instrument --entry env.fork",
    );
  }
  if (importsFork && !sideEntryAvailable) {
    throw new Error(
      `${name}: env.fork requires the versioned side-entry capability; ` +
      "rebuild with the current wasm-fork-instrument --entry env.fork",
    );
  }
  if (
    options.forkActivationOwner
    && hasCompleteForkInstrumentation
    && !sideEntryAvailable
  ) {
    throw new Error(
      `${name}: fork-capable process requires the versioned side-entry `
      + "boundary capability; rebuild the side module",
    );
  }
  if (
    requiredForkFunctionImportCount !== 0
    && requiredForkFunctionImportCount !== requiredForkFunctionImportNames.length
  ) {
    throw new Error(`${name}: incomplete linked fork instrumentation imports; rebuild the module`);
  }
  if (
    importsFork
    && requiredForkFunctionImportCount !== requiredForkFunctionImportNames.length
  ) {
    throw new Error(`${name}: env.fork requires ABI 43 linked continuation imports`);
  }
  if (hasCompleteForkInstrumentation && !options.forkActivationOwner) {
    throw new Error(
      `${name}: fork activation cannot be coordinated: ` +
        (options.forkActivationOwnerUnavailableReason
          ?? "ABI 43 side modules require a process activation owner"),
    );
  }
  if (
    hasCompleteForkInstrumentation
    && replay !== undefined
    && replay.activationId === undefined
  ) {
    throw new Error(`${name}: fork replay is missing its archived activation id`);
  }
  const replayActivationId = replay?.activationId === undefined
    ? undefined
    : requireNonzeroU32(
        replay.activationId,
        `${name}: archived activation id`,
      );
  if (!hasCompleteForkInstrumentation && replay?.activationId !== undefined) {
    throw new Error(
      `${name}: fork replay supplied an activation id for an uninstrumented module`,
    );
  }

  const tableRollbackBase = tableLength(options.table);
  const heapRollbackValue = options.heapPointer?.value;
  const symbolRollback = new Map(options.globalSymbols);
  const owners = symbolOwners(options);
  const ownerRollback = new Map(owners);
  const gotRollback = new Map(
    Array.from(options.got, ([symbol, global]) => [
      symbol,
      { global, value: global.value },
    ] as const),
  );
  const gotKinds = options.gotKinds ??= new Map();
  const gotKindsRollback = new Map(gotKinds);
  const allocations: DylinkForkMemoryAllocation[] = [];
  const ownedTableEntries = new Set<number>();
  const gotImports = new Map<string, "mem" | "func">();
  const localGot = new Map<string, WebAssembly.Global>();
  const providerDependencies = new Set(
    replay?.providerDependencies ?? [],
  );
  const recordProvider = (owner: string | undefined): void => {
    if (owner !== undefined && owner !== name) {
      providerDependencies.add(owner);
    }
  };
  let preparedActivation: PreparedDylinkForkActivation | undefined;
  let preparedActivationId: number | undefined;
  let provisionalLibrary: LoadedSharedLibrary | undefined;
  let forkActivationReleased = false;
  const unregisterForkActivation = (): void => {
    if (!preparedActivation || forkActivationReleased) return;
    // WHY: registration may have partially succeeded before throwing. The
    // owner's teardown is the only authority that can release the activation
    // ID, resume catalog, typed roots, and continuation binding atomically.
    forkActivationReleased = true;
    preparedActivation.unregister();
  };
  const allocate = (size: number, align: number): number => {
    if (!options.allocateMemory) {
      throw new Error(`${name}: no side-module memory allocator configured`);
    }
    const address = options.allocateMemory(size, align);
    const described = options.describeMemoryAllocation?.(address, size);
    allocations.push(copyForkMemoryAllocation({
      address,
      size,
      mappingAddress: described?.mappingAddress ?? address,
      mappingSize: described?.mappingSize ?? size,
    }, `${name}: allocated side-module memory`));
    return address;
  };

  try {
    if (hasCompleteForkInstrumentation) {
      preparedActivation = options.forkActivationOwner!.prepare({
        name,
        module,
        moduleBytes: wasmBytes,
        replayActivationId,
      });
      if (
        !preparedActivation
        || typeof preparedActivation !== "object"
        || typeof preparedActivation.wrapImports !== "function"
        || typeof preparedActivation.register !== "function"
        || typeof preparedActivation.unregister !== "function"
        || !preparedActivation.env
        || typeof preparedActivation.env !== "object"
      ) {
        throw new TypeError(`${name}: activation owner returned an invalid preparation`);
      }
      preparedActivationId = requireNonzeroU32(
        preparedActivation.activationId,
        `${name}: prepared activation id`,
      );
      if (
        replayActivationId !== undefined
        && preparedActivationId !== replayActivationId
      ) {
        throw new Error(
          `${name}: activation owner returned ${preparedActivationId}, `
          + `but replay requires ${replayActivationId}`,
        );
      }
    }

    // Allocate memory region
    const memAlign = 1 << metadata.memoryAlign;
    let memoryBase = 0;
    if (metadata.memorySize > 0) {
      if (replay) {
        // Reuse parent's memoryBase: data-reloc'd pointers baked into the
        // memcpy'd data section already encode (parentMemoryBase + offset).
        memoryBase = replay.memoryBase;
        const archivedAllocations = (replay.allocations ?? []).map(
          (allocation, index) => copyForkMemoryAllocation(
            allocation,
            `${name}: archived allocation ${index}`,
          ),
        );
        if (
          archivedAllocations.length !== 0
          && (
            archivedAllocations.length !== 1
            || archivedAllocations[0]!.address !== memoryBase
            || archivedAllocations[0]!.size !== metadata.memorySize
          )
        ) {
          throw new Error(
            `${name}: archived allocation does not match its dylink memory region`,
          );
        }
        if (
          options.adoptMemoryAllocation
          && archivedAllocations.length === 0
        ) {
          throw new Error(
            `${name}: fork replay is missing process mapping ownership`,
          );
        }
        for (const allocation of archivedAllocations) {
          if (
            allocation.mappingAddress
              > options.memory.buffer.byteLength - allocation.mappingSize
          ) {
            throw new RangeError(
              `${name}: archived process mapping escapes copied linear memory`,
            );
          }
          // WHY: fork copied both kernel mmap state and the bytes, but the new
          // Worker has an empty JS allocator index. Adopt that ownership; do
          // not allocate or zero a second region.
          options.adoptMemoryAllocation?.(allocation);
          allocations.push(allocation);
        }
      } else if (options.allocateMemory) {
        memoryBase = allocate(metadata.memorySize, memAlign);
        const end = memoryBase + metadata.memorySize;
        if (end > options.memory.buffer.byteLength) {
          throw new Error(
            `${name}: allocator returned 0x${memoryBase.toString(16)} but memory only covers 0x${options.memory.buffer.byteLength.toString(16)}`,
          );
        }
      } else {
        if (!options.heapPointer) {
          throw new Error(`${name}: no side-module memory allocator configured`);
        }
        memoryBase = alignUp(options.heapPointer.value, memAlign);
        options.heapPointer.value = memoryBase + metadata.memorySize;

        // Ensure the memory is large enough for standalone linker tests and
        // non-POSIX embedders. Process workers pass allocateMemory so side-module
        // data is tracked by the guest allocator instead of a host-only pointer.
        const neededPages = Math.ceil(options.heapPointer.value / 65536);
        const currentPages = options.memory.buffer.byteLength / 65536;
        if (neededPages > currentPages) {
          growMemory(options.memory, neededPages - currentPages, ptrWidth);
        }
      }

      if (!replay) {
        // Skip zero-init in replay: child memory already holds parent's
        // post-startup data via fork memcpy.
        new Uint8Array(options.memory.buffer, memoryBase, metadata.memorySize).fill(0);
      }
    } else if ((replay?.allocations?.length ?? 0) !== 0) {
      throw new Error(`${name}: zero-memory side module owns archived mappings`);
    }

    // Reproduce the parent's exact table base, including null gaps left by a
    // failed dlopen. WebAssembly.Table cannot shrink, so successful archive
    // entries carry the next library's exact base and replay pads up to it.
    let tableBase = tableLength(options.table);
    if (replay) {
      if (!Number.isSafeInteger(replay.tableBase) || replay.tableBase < 0) {
        throw new Error(`${name}: invalid replay table base ${replay.tableBase}`);
      }
      if (tableBase > replay.tableBase) {
        throw new Error(
          `${name}: replay table already at ${tableBase}, past parent base ${replay.tableBase}`,
        );
      }
      if (tableBase < replay.tableBase) {
        growTable(options.table, replay.tableBase - tableBase);
      }
      tableBase = replay.tableBase;
    }
    if (metadata.tableSize > 0) {
      growTable(options.table, metadata.tableSize);
      for (let index = 0; index < metadata.tableSize; index++) {
        ownedTableEntries.add(tableBase + index);
      }
    }

    // Create immutable globals for memory_base and table_base
    const memoryBaseGlobal = new WebAssembly.Global(
      { value: pointerGlobalType, mutable: false },
      wasmAddress(memoryBase, ptrWidth, `${name}: memory base`),
    );
    const tableBaseGlobal = new WebAssembly.Global(
      {
        value: typeof (options.table as unknown as AddressedTable).length === "bigint"
          ? "i64"
          : "i32",
        mutable: false,
      },
      tableAddress(options.table, tableBase, `${name}: table base`),
    );

    // Build GOT proxy for imports.
    //
    // GOT.mem entries hold the *address in linear memory* of a data symbol the
    // side module imports from the main process. If the main module exports
    // that symbol as a WebAssembly.Global (typical for `--export-all`), its
    // value is the address. Without this seeding, side modules read 0 for
    // any imported global — silent NULL deref (e.g. opcache.so reads
    // `sapi_module.name` as NULL, accel_find_sapi fails at startup).
    //
    // GOT.func entries hold a *table index* — the address-of-function value
    // a C function pointer stores. Side-module data sections capture function
    // pointers (e.g. opcache.so's ini_entries[].on_modify == &OnUpdateString
    // exported from main). For those references to dispatch to the real
    // function at runtime, the function must live in the shared
    // indirect_function_table and the GOT entry must hold its index.
    const tableIndexFor = (fn: Function): number => {
      const existing = functionTableIndex(options, fn);
      if (existing !== undefined) return existing;
      const tbl = options.table;
      const length = tableLength(tbl);
      const idx = length;
      growTable(tbl, 1);
      setTableEntry(tbl, idx, fn);
      options.onTableMutation?.(tbl, idx, 1);
      return idx;
    };

    const getOrCreateGOTEntry = (
      symName: string,
      kind: "mem" | "func",
    ): WebAssembly.Global => {
      const resolved = scopedSymbol(options, dependencyScope, symName);
      recordProvider(resolved?.owner);
      if (
        resolved
        && (
          (kind === "mem" && !(resolved.value instanceof WebAssembly.Global))
          || (kind === "func" && typeof resolved.value !== "function")
        )
      ) {
        throw new Error(
          `${name}: GOT.${kind} symbol ${symName} has the wrong kind`,
        );
      }
      const resolvedFunctionIndex =
        kind === "func" && typeof resolved?.value === "function"
          ? tableIndexFor(resolved.value)
          : undefined;
      const globallyResolved =
        resolved !== undefined
        && options.globalSymbols.get(symName) === resolved.value;
      const localKey = `${kind}:${symName}`;
      const selfExportKind = moduleExportKinds.get(symName);
      const isSelfReference =
        resolved === undefined
        && (
          (kind === "mem" && selfExportKind === "global")
          || (kind === "func" && selfExportKind === "function")
        );

      // A LOCAL dependency and a module's own interposable export must not
      // acquire a process-global GOT cell. The importing instance owns this
      // cell, and its exact provider is captured in the dependency closure.
      if ((resolved && !globallyResolved) || isSelfReference) {
        let localEntry = localGot.get(localKey);
        if (!localEntry) {
          let initial = wasmAddress(
            0,
            ptrWidth,
            `${name}: local GOT.${kind}.${symName}`,
          );
          if (resolved) {
            initial = kind === "mem"
              ? requireWasmAddress(
                  (resolved.value as WebAssembly.Global).value as WasmAddress,
                  ptrWidth,
                  `${name}: local GOT.mem.${symName}`,
                )
              : wasmAddress(
                  resolvedFunctionIndex!,
                  ptrWidth,
                  `${name}: local GOT.func.${symName}`,
                );
          }
          localEntry = new WebAssembly.Global(
            { value: pointerGlobalType, mutable: true },
            initial,
          );
          localGot.set(localKey, localEntry);
        }
        return localEntry;
      }

      const knownKind = gotKinds.get(symName);
      if (knownKind !== undefined && knownKind !== kind) {
        throw new Error(
          `${name}: GOT symbol ${symName} is both ${knownKind} and ${kind}`,
        );
      }
      gotKinds.set(symName, kind);
      gotImports.set(symName, kind);
      let entry = options.got.get(symName);
      if (!entry) {
        let initial = wasmAddress(0, ptrWidth, `${name}: GOT.${kind}.${symName}`);
        if (kind === "mem" && resolved?.value instanceof WebAssembly.Global) {
          initial = requireWasmAddress(
            resolved.value.value as WasmAddress,
            ptrWidth,
            `${name}: GOT.mem.${symName}`,
          );
        } else if (resolvedFunctionIndex !== undefined) {
          initial = wasmAddress(
            resolvedFunctionIndex,
            ptrWidth,
            `${name}: GOT.func.${symName}`,
          );
        }
        entry = new WebAssembly.Global(
          { value: pointerGlobalType, mutable: true },
          initial,
        );
        options.got.set(symName, entry);
      } else {
        requireWasmAddress(
          entry.value as WasmAddress,
          ptrWidth,
          `${name}: existing GOT.${kind}.${symName}`,
        );
        if (kind === "mem" && resolved?.value instanceof WebAssembly.Global) {
          entry.value = requireWasmAddress(
            resolved.value.value as WasmAddress,
            ptrWidth,
            `${name}: GOT.mem.${symName}`,
          );
        } else if (resolvedFunctionIndex !== undefined) {
          entry.value = wasmAddress(
            resolvedFunctionIndex,
            ptrWidth,
            `${name}: GOT.func.${symName}`,
          );
        }
      }
      return entry;
    };

    let instance: WebAssembly.Instance | null = null;
    const routeFunctionImport = (
      moduleName: string,
      importName: string,
      value: WebAssembly.ImportValue | WebAssembly.Tag | undefined,
    ): WebAssembly.ImportValue | WebAssembly.Tag | undefined => {
      if (typeof value !== "function" || !options.routeFunctionImport) {
        return value;
      }
      const key = `${moduleName.length}:${moduleName}${importName}`;
      const entries = functionImportsByName.get(key);
      if (!entries || entries.length === 0) return value;
      const read = functionImportReads.get(key) ?? 0;
      const imported = entries[Math.min(read, entries.length - 1)]!;
      functionImportReads.set(key, read + 1);
      return options.routeFunctionImport(imported, value);
    };

    // Construct imports
    const imports: WebAssembly.Imports = {
      env: new Proxy({} as Record<string, WebAssembly.ImportValue>, {
        get(_target, prop: string) {
          let value: WebAssembly.ImportValue | WebAssembly.Tag | undefined;
          switch (prop) {
            case "memory": value = options.memory; break;
            case "__indirect_function_table": value = options.table; break;
            case "__memory_base": value = memoryBaseGlobal; break;
            case "__table_base": value = tableBaseGlobal; break;
            case "__stack_pointer": value = options.stackPointer; break;
            case "__c_longjmp": value = longjmpTag; break;
            case "__cpp_exception": value = cppExceptionTag; break;
            case FORK_UNWIND_TAG_IMPORT_NAME:
              if (
                preparedActivation
                && Object.hasOwn(preparedActivation.env, prop)
              ) {
                value = preparedActivation.env[prop];
              } else if (hasCompleteForkInstrumentation) {
                // WHY: an ABI 43 linked continuation has one process-level
                // activation owner. Letting this tag fall back independently
                // could bind unwind exceptions to a different realm than the
                // owner's frame and exception reconstruction imports.
                value = undefined;
              } else {
                value = importsForkUnwindTag
                  ? requireForkUnwindTag(options.forkUnwindTag, name)
                  : undefined;
              }
              break;
            default:
              if (
                preparedActivation
                && Object.hasOwn(preparedActivation.env, prop)
              ) {
                value = preparedActivation.env[prop];
              } else if (
                hasCompleteForkInstrumentation
                && (prop === "fork" || prop.startsWith("__wpk_fork_"))
              ) {
                // WHY: falling through to a process symbol would split
                // ownership between the loader and coordinator. Missing
                // activation imports fail before the side module executes.
                value = undefined;
              } else {
                const resolved = scopedSymbol(
                  options,
                  dependencyScope,
                  prop,
                );
                if (resolved !== undefined) {
                  recordProvider(resolved.owner);
                  value = resolved.value;
                } else if (selfFunctionImports.has(prop)) {
                  value = (...args: unknown[]) => {
                    const fn = instance?.exports[prop];
                    if (typeof fn !== "function") {
                      throw new Error(`${name}: self import env.${prop} is unavailable`);
                    }
                    return (fn as Function)(...args);
                  };
                }
              }
          }
          return routeFunctionImport("env", prop, value);
        },
        has(_target, prop: string) {
          if (["memory", "__indirect_function_table", "__memory_base",
               "__table_base", "__stack_pointer", "__c_longjmp",
               "__cpp_exception"].includes(prop)) return true;
          if (
            preparedActivation
            && Object.hasOwn(preparedActivation.env, prop)
          ) return true;
          if (
            hasCompleteForkInstrumentation
            && (prop === "fork" || prop.startsWith("__wpk_fork_"))
          ) return false;
          return scopedSymbol(options, dependencyScope, prop) !== undefined
            || selfFunctionImports.has(prop);
        },
      }),
      "GOT.mem": new Proxy({} as Record<string, WebAssembly.Global>, {
        get(_target, prop: string) {
          return getOrCreateGOTEntry(prop, "mem");
        },
      }),
      "GOT.func": new Proxy({} as Record<string, WebAssembly.Global>, {
        get(_target, prop: string) {
          return getOrCreateGOTEntry(prop, "func");
        },
      }),
    };

    // Imported global/table identity is observable only while WebAssembly
    // lazily resolves this exact proxy graph. Give the process owner one
    // synchronous wrapper boundary; eager enumeration would collapse duplicate
    // `(module, name)` declarations and capture the wrong provider.
    const instanceImports = preparedActivation
      ? preparedActivation.wrapImports(imports)
      : imports;
    if (!instanceImports || typeof instanceImports !== "object") {
      throw new TypeError(`${name}: activation owner returned invalid wrapped imports`);
    }

    // Instantiate synchronously after validating the side-module fork contract.
    instance = new WebAssembly.Instance(module, instanceImports);
    preparedActivation?.register(instance);
    const ownedModuleBytes = wasmBytes.slice();
    const initializationForkState = (
      tlsBase?: number,
    ): DylinkForkLibraryState => ({
      name,
      moduleBytes: ownedModuleBytes,
      memoryBase,
      tableBase,
      activationId: preparedActivationId,
      globalVisibility,
      ...(allocations.length === 0
        ? {}
        : { allocations: allocations.map((allocation) => ({ ...allocation })) }),
      ...(tlsBase === undefined ? {} : { tlsBase }),
    });
    provisionalLibrary = {
      instance,
      memoryBase,
      tableBase,
      exports: {},
      metadata,
      name,
      moduleBytes: ownedModuleBytes,
      activationId: preparedActivationId,
      ownedTableEntries: [],
      gotImports: [],
      unregisterForkActivation: preparedActivation
        ? unregisterForkActivation
        : undefined,
      loadState: "initializing",
      globalVisibility,
      providerDependencies,
      allocations,
      heapReservationEnd: options.heapPointer?.value,
    };
    options.loadedLibraries.set(name, provisionalLibrary);
    loadContext?.ownedLibraries.add(provisionalLibrary);
    let stateAfterBootstrap: DylinkForkLibraryState | undefined;
    if (
      preparedActivation
      && (!replay || replay.initializationStage !== undefined)
    ) {
      const bootstrap = instance.exports.wpk_fork_module_bootstrap;
      if (typeof bootstrap !== "function") {
        throw new Error(`${name}: fork activation is missing its module bootstrap`);
      }
      // WHY: activation registration must not itself enter guest code. Keeping
      // bootstrap at the loader boundary lets the process/libc staged loader
      // replace this direct call with a normal Wasm table call without
      // changing activation ownership or registration ordering.
      stateAfterBootstrap = yield {
        libraryName: name,
        stage: "bootstrap",
        forkState: initializationForkState(),
        invoke: bootstrap as () => void,
      };
    }

    // A threaded wasm-ld side module initializes its mutable __tls_base from
    // __memory_base in the start function. Fork-child memory already carries
    // the parent's `__wasm_init_memory_flag == 2`, so the fresh child instance
    // skips that initialization and otherwise leaves __tls_base at zero.
    // Capture the live parent value and restore it during replay without
    // calling __wasm_init_tls: the latter would overwrite copied, live TLS
    // state (including the C++ unwinder's landing-pad context) with .tdata.
    const tlsSizeExport = instance.exports.__tls_size;
    const tlsSize = tlsSizeExport instanceof WebAssembly.Global
      ? Number(tlsSizeExport.value)
      : 0;
    let tlsBase: number | undefined;
    if (metadata.tlsExports.size > 0 && !(tlsSizeExport instanceof WebAssembly.Global)) {
      throw new Error(`${name}: TLS exports require an exported __tls_size global`);
    }
    if (!Number.isSafeInteger(tlsSize) || tlsSize < 0) {
      throw new Error(`${name}: invalid side-module TLS size ${String(tlsSize)}`);
    }
    if (tlsSize > 0) {
      const tlsBaseExport = instance.exports.__tls_base;
      const tlsAlignExport = instance.exports.__tls_align;
      if (!(tlsBaseExport instanceof WebAssembly.Global)) {
        throw new Error(
          `${name}: TLS-bearing side modules must export mutable __tls_base for fork replay`,
        );
      }
      if (!(tlsAlignExport instanceof WebAssembly.Global)) {
        throw new Error(`${name}: TLS-bearing side modules must export __tls_align`);
      }
      const tlsAlign = Number(tlsAlignExport.value);
      if (
        !Number.isSafeInteger(tlsAlign)
        || tlsAlign <= 0
        || (tlsAlign & (tlsAlign - 1)) !== 0
      ) {
        throw new Error(`${name}: invalid side-module TLS alignment ${String(tlsAlign)}`);
      }

      const initialRawTlsBase = tlsBaseExport.value;
      const expectedTlsBaseType = (options.ptrWidth ?? 4) === 8 ? "bigint" : "number";
      if (typeof initialRawTlsBase !== expectedTlsBaseType) {
        throw new Error(
          `${name}: __tls_base type does not match the ${(options.ptrWidth ?? 4) * 8}-bit process pointer width`,
        );
      }
      try {
        // A self-assignment is the only portable reflection available for
        // distinguishing a mutable WebAssembly.Global from an immutable one.
        tlsBaseExport.value = initialRawTlsBase;
      } catch {
        throw new Error(`${name}: exported __tls_base must be mutable for fork replay`);
      }
      if (replay) {
        const replayTlsBase = stateAfterBootstrap?.tlsBase ?? replay.tlsBase;
        if (replayTlsBase !== undefined) {
          if (!Number.isSafeInteger(replayTlsBase) || replayTlsBase <= 0) {
            throw new Error(`${name}: fork replay is missing a valid side-module TLS base`);
          }
          try {
            tlsBaseExport.value = typeof initialRawTlsBase === "bigint"
              ? BigInt(replayTlsBase)
              : replayTlsBase;
          } catch {
            throw new Error(`${name}: exported __tls_base must be mutable for fork replay`);
          }
        } else if (replay.initializationStage !== "bootstrap") {
          throw new Error(`${name}: fork replay is missing a valid side-module TLS base`);
        }
        // A child stopped inside bootstrap has no archived TLS value yet.
        // Once its restored bootstrap call returns, the instance-local global
        // is authoritative. A non-calling pthread replica instead receives the
        // later archived value through the generator resume above.
        try {
          tlsBaseExport.value = tlsBaseExport.value;
        } catch {
          throw new Error(`${name}: exported __tls_base must be mutable for fork replay`);
        }
      }
      tlsBase = Number(tlsBaseExport.value);
      // Address zero is reserved as the archive's explicit "no TLS" sentinel.
      // A real TLS allocation cannot live there: the process memory allocator
      // always returns a positive address and the null page must stay invalid.
      if (!Number.isSafeInteger(tlsBase) || tlsBase <= 0) {
        throw new Error(`${name}: invalid side-module TLS base ${String(tlsBase)}`);
      }
      if (tlsBase % tlsAlign !== 0) {
        throw new Error(
          `${name}: side-module TLS base 0x${tlsBase.toString(16)} is not aligned to ${tlsAlign}`,
        );
      }
      const tlsEnd = tlsBase + tlsSize;
      const moduleMemoryEnd = memoryBase + metadata.memorySize;
      if (
        !Number.isSafeInteger(tlsEnd)
        || tlsBase < memoryBase
        || tlsEnd > moduleMemoryEnd
      ) {
        throw new Error(
          `${name}: TLS range 0x${tlsBase.toString(16)}..0x${tlsEnd.toString(16)} ` +
            `escapes module reservation 0x${memoryBase.toString(16)}..0x${moduleMemoryEnd.toString(16)}`,
        );
      }
      if (tlsEnd > options.memory.buffer.byteLength) {
        throw new Error(
          `${name}: TLS range 0x${tlsBase.toString(16)}..0x${tlsEnd.toString(16)} exceeds memory`,
        );
      }
    } else if (replay?.tlsBase !== undefined) {
      throw new Error(`${name}: fork replay supplied TLS state for a module without TLS`);
    }

    // Relocate exports: data address globals need memoryBase added
    const relocatedExports: Record<string, WebAssembly.ExportValue> = {};
    for (const [exportName, exportValue] of Object.entries(instance.exports)) {
      if (exportValue instanceof WebAssembly.Global) {
        try {
          (exportValue as any).value = (exportValue as any).value;
          relocatedExports[exportName] = exportValue;
        } catch {
          // These are scalar ABI facts, not data addresses.
          if (exportName === "__tls_size" || exportName === "__tls_align") {
            relocatedExports[exportName] = exportValue;
            continue;
          }
          const rawValue = exportValue.value;
          const relocationBase = metadata.tlsExports.has(exportName)
            ? tlsBase
            : memoryBase;
          if (relocationBase === undefined) {
            throw new Error(`${name}: TLS export ${exportName} has no live TLS base`);
          }
          relocatedExports[exportName] = new WebAssembly.Global(
            { value: typeof rawValue === "bigint" ? "i64" : "i32", mutable: false },
            typeof rawValue === "bigint"
              ? rawValue + BigInt(relocationBase)
              : rawValue + relocationBase,
          );
        }
      } else {
        relocatedExports[exportName] = exportValue;
      }
    }
    provisionalLibrary.exports = relocatedExports;
    provisionalLibrary.tlsBase = tlsBase;

    // Update GOT with this library's exports
    for (const [exportName, exportValue] of Object.entries(relocatedExports)) {
      if (exportName.startsWith("__") || isForkRuntimeExport(exportName)) {
        // WHY: these are activation-control entry points, not ELF-visible
        // application symbols. Publishing them would put post-catalog
        // instrumenter helpers into the mutable process table and manufacture
        // reference state with no source-function reconstruction recipe.
        continue;
      }
      const alreadyDefined = options.globalSymbols.has(exportName);

      if (typeof exportValue === "function") {
        const tableIdx = tableLength(options.table);
        growTable(options.table, 1);
        setTableEntry(options.table, tableIdx, exportValue as unknown as Function);
        ownedTableEntries.add(tableIdx);
        // This write is performed by the host loader, outside generated
        // table.set instrumentation. Attribute it to the shared table owner so
        // fork captures the side function as an activation+ordinal recipe.
        options.onTableMutation?.(options.table, tableIdx, 1);

        const localEntry = localGot.get(`func:${exportName}`);
        if (localEntry) {
          localEntry.value = wasmAddress(
            tableIdx,
            ptrWidth,
            `${name}: local GOT.func.${exportName}`,
          );
        }
        const gotEntry = options.got.get(exportName);
        if (globalVisibility && gotEntry) {
          const gotKind = gotKinds.get(exportName);
          if (gotKind !== undefined && gotKind !== "func") {
            throw new Error(`${name}: GOT symbol ${exportName} changes kind`);
          }
          gotKinds.set(exportName, "func");
          if (!alreadyDefined) {
            gotEntry.value = wasmAddress(
              tableIdx,
              ptrWidth,
              `${name}: GOT.func.${exportName}`,
            );
          }
        }
        if (globalVisibility && !alreadyDefined) {
          options.globalSymbols.set(exportName, exportValue as Function);
          owners.set(exportName, name);
        }
      } else if (exportValue instanceof WebAssembly.Global) {
        const addr = (exportValue as WebAssembly.Global).value;
        const localEntry = localGot.get(`mem:${exportName}`);
        if (localEntry) {
          localEntry.value = requireWasmAddress(
            addr as WasmAddress,
            ptrWidth,
            `${name}: local GOT.mem.${exportName}`,
          );
        }
        const gotEntry = options.got.get(exportName);
        if (globalVisibility && gotEntry) {
          const gotKind = gotKinds.get(exportName);
          if (gotKind !== undefined && gotKind !== "mem") {
            throw new Error(`${name}: GOT symbol ${exportName} changes kind`);
          }
          gotKinds.set(exportName, "mem");
          if (!alreadyDefined) {
            gotEntry.value = requireWasmAddress(
              addr as WasmAddress,
              ptrWidth,
              `${name}: GOT.mem.${exportName}`,
            );
          }
        }
        if (globalVisibility && !alreadyDefined) {
          options.globalSymbols.set(exportName, exportValue);
          owners.set(exportName, name);
        }
      }
    }

    // Run data relocations
    const applyRelocs = instance.exports.__wasm_apply_data_relocs as Function | undefined;
    if (applyRelocs && (!replay || replay.initializationStage !== undefined)) {
      // A complete fork replay receives already-relocated live bytes from the
      // parent. Re-running this entry would relocate pointers a second time.
      // An in-flight replay still yields the full stage sequence so the
      // archived selector can stop at the exact guest call being resumed.
      yield {
        libraryName: name,
        stage: "relocations",
        forkState: initializationForkState(tlsBase),
        invoke: applyRelocs as () => void,
      };
    }

    if (!replay || replay.initializationStage !== undefined) {
      // Skip ctors in replay: parent already ran them and post-startup state
      // (e.g. opcache accel_globals, registered INI entries) is in the
      // memcpy'd data; re-running would clobber it.
      const ctors = instance.exports.__wasm_call_ctors as Function | undefined;
      if (ctors) {
        yield {
          libraryName: name,
          stage: "constructors",
          forkState: initializationForkState(tlsBase),
          invoke: ctors as () => void,
        };
      }
    }

    provisionalLibrary.ownedTableEntries =
      [...ownedTableEntries].sort((left, right) => left - right);
    provisionalLibrary.gotImports = [...gotImports]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([symbol, kind]) => Object.freeze({ name: symbol, kind }));
    provisionalLibrary.providerDependencies = new Set(providerDependencies);
    provisionalLibrary.allocations = allocations.map((allocation) =>
      copyForkMemoryAllocation(allocation, `${name}: live allocation`)
    );
    provisionalLibrary.heapReservationEnd = options.heapPointer?.value;
    provisionalLibrary.loadState = "loaded";
    return provisionalLibrary;
  } catch (error) {
    if (
      provisionalLibrary
      && options.loadedLibraries.get(name) === provisionalLibrary
    ) {
      options.loadedLibraries.delete(name);
    }
    let activationReleaseError: unknown;
    try {
      unregisterForkActivation();
    } catch (releaseError) {
      activationReleaseError = releaseError;
    }
    // Restore every mutable host-side linker structure we can. Table length and
    // Wasm memory cannot shrink, so clear newly-addressable table slots and let
    // the next successful archive entry record the resulting exact table base.
    const rollbackTableEnd = tableLength(options.table);
    for (let i = tableRollbackBase; i < rollbackTableEnd; i++) {
      try {
        setTableEntry(options.table, i, null);
      } catch { /* best-effort for nullable funcref */ }
    }
    options.globalSymbols.clear();
    for (const [symbol, value] of symbolRollback) options.globalSymbols.set(symbol, value);
    owners.clear();
    for (const [symbol, owner] of ownerRollback) owners.set(symbol, owner);
    options.got.clear();
    for (const [symbol, snapshot] of gotRollback) {
      try { snapshot.global.value = snapshot.value; } catch { /* immutable should not occur */ }
      options.got.set(symbol, snapshot.global);
    }
    gotKinds.clear();
    for (const [symbol, kind] of gotKindsRollback) {
      gotKinds.set(symbol, kind);
    }
    if (options.heapPointer && heapRollbackValue !== undefined) {
      options.heapPointer.value = heapRollbackValue;
    }
    if (options.deallocateMemory) {
      for (const allocation of allocations.reverse()) {
        try {
          options.deallocateMemory(allocation.address, allocation.size);
        } catch { /* preserve cause */ }
      }
    }
    if (activationReleaseError !== undefined) {
      throw new AggregateError(
        [error, activationReleaseError],
        `${name}: side-module load failed and activation rollback was incomplete`,
      );
    }
    throw error;
  }
}

function driveDylinkInitialization(
  steps: Generator<
    DylinkInitializationStep,
    LoadedSharedLibrary,
    DylinkForkLibraryState | undefined
  >,
): LoadedSharedLibrary {
  let cursor = steps.next();
  while (!cursor.done) {
    try {
      cursor.value.invoke();
    } catch (error) {
      // Re-enter the generator at its guarded yield so its ordinary rollback
      // path releases allocations, table entries, and activation ownership.
      // A process/libc staged driver deliberately does not do this for the
      // private fork unwind: the same generator remains live until replay
      // returns to the next state transition.
      return steps.throw(error).value as never;
    }
    cursor = steps.next();
  }
  return cursor.value;
}

function instantiateSharedLibrary(
  name: string,
  wasmBytes: Uint8Array,
  metadata: DylinkMetadata,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
  globalVisibility = true,
  dependencyScope: readonly LoadedSharedLibrary[] = [],
): LoadedSharedLibrary {
  return driveDylinkInitialization(
    instantiateSharedLibrarySteps(
      name,
      wasmBytes,
      metadata,
      options,
      replay,
      undefined,
      globalVisibility,
      dependencyScope,
    ),
  );
}

/**
 * Load a shared library (.so / side module) into a process's address space.
 * Async version — uses async WebAssembly compilation for large modules and
 * supports async dependency resolution.
 *
 * Replay is not supported on the async path; fork replays go through
 * `loadSharedLibrarySync` / `DynamicLinker.dlopenSync`.
 */
export async function loadSharedLibrary(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
  globalVisibility = true,
): Promise<LoadedSharedLibrary> {
  validateLongjmpConfiguration(options);
  const existing = options.loadedLibraries.get(name);
  if (existing) {
    if (globalVisibility && !existing.globalVisibility) {
      promoteLibraryGlobal(existing, options);
      refreshGlobalGotEntries(options);
    }
    return existing;
  }

  const metadata = parseDylinkSection(wasmBytes);
  if (!metadata) {
    throw new Error(`${name}: not a shared library (no dylink.0 section)`);
  }

  // Load dependencies first
  for (const dep of metadata.neededDynlibs) {
    if (options.loadedLibraries.has(dep)) continue;
    if (!options.resolveLibrary) {
      throw new Error(`${name}: depends on ${dep} but no resolveLibrary callback provided`);
    }
    const depBytes = await options.resolveLibrary(dep, name);
    if (!depBytes) {
      throw new Error(`${name}: dependency ${dep} not found`);
    }
    await loadSharedLibrary(dep, depBytes, options, globalVisibility);
  }

  const dependencyScope: LoadedSharedLibrary[] = [];
  appendDependencyScope(
    dependencyScope,
    metadata.neededDynlibs.map((dependencyName) => {
      const dependency = options.loadedLibraries.get(dependencyName);
      if (!dependency) {
        throw new Error(`${name}: loaded dependency ${dependencyName} is missing`);
      }
      return dependency;
    }),
    options,
  );
  return instantiateSharedLibrary(
    name,
    wasmBytes,
    metadata,
    options,
    undefined,
    globalVisibility,
    dependencyScope,
  );
}

/**
 * Load a shared library synchronously. Required for dlopen() which must
 * return synchronously to C code. Uses synchronous WebAssembly compilation.
 */
function* loadSharedLibrarySyncSteps(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
  replayModules?: ReadonlyMap<string, DylinkForkLibraryState>,
  loadContext?: DylinkLoadContext,
  globalVisibility = true,
): Generator<
  DylinkInitializationStep,
  LoadedSharedLibrary,
  DylinkForkLibraryState | undefined
> {
  validateLongjmpConfiguration(options);
  const existing = options.loadedLibraries.get(name);
  if (existing) {
    if (replay) {
      throw new Error(
        `${name}: fork replay cannot reuse an already-loaded library; `
        + "archive entries must be unique",
      );
    }
    if (globalVisibility && !existing.globalVisibility) {
      promoteLibraryGlobal(existing, options);
      refreshGlobalGotEntries(options);
    }
    return existing;
  }

  const metadata = parseDylinkSection(wasmBytes);
  if (!metadata) {
    throw new Error(`${name}: not a shared library (no dylink.0 section)`);
  }

  // Parent archive entries are emitted in dependency-first load order. A
  // child must replay each dependency with its own exact layout/activation
  // record before replaying this consumer; silently allocating a missing dep
  // here would choose fresh addresses and corrupt copied relocations.
  for (const dep of metadata.neededDynlibs) {
    if (options.loadedLibraries.has(dep)) continue;
    const archivedDependency = replayModules?.get(dep);
    if (replay && !archivedDependency) {
      throw new Error(
        `${name}: fork replay is missing dependency ${dep}; `
        + "archive entries must be replayed in dependency order",
      );
    }
    if (!archivedDependency && !options.resolveLibrarySync) {
      throw new Error(`${name}: depends on ${dep} but no resolveLibrarySync callback provided`);
    }
    const depBytes = archivedDependency
      ? new Uint8Array(archivedDependency.moduleBytes)
      : options.resolveLibrarySync!(dep, name);
    if (!depBytes) {
      throw new Error(`${name}: dependency ${dep} not found`);
    }
    const loadedDependency = yield* loadSharedLibrarySyncSteps(
      dep,
      depBytes,
      options,
      archivedDependency
        ? {
            memoryBase: archivedDependency.memoryBase,
            tableBase: archivedDependency.tableBase,
            activationId: archivedDependency.activationId,
            tlsBase: archivedDependency.tlsBase,
            globalVisibility: archivedDependency.globalVisibility,
            committedGlobalRoot: archivedDependency.committedGlobalRoot,
            providerDependencies: archivedDependency.providerDependencies,
            allocations: archivedDependency.allocations,
            initializationStage:
              archivedDependency.initialization?.stage,
          }
        : undefined,
      replayModules,
      loadContext,
      archivedDependency?.globalVisibility ?? globalVisibility,
    );
    if (archivedDependency) {
      loadedDependency.committedGlobalRoot =
        archivedDependency.committedGlobalRoot;
      loadedDependency.providerDependencies = new Set(
        archivedDependency.providerDependencies
          ?? loadedDependency.providerDependencies
          ?? [],
      );
    }
  }

  const archivedSelf = replayModules?.get(name);
  const effectiveGlobalVisibility =
    archivedSelf?.globalVisibility
    ?? replay?.globalVisibility
    ?? globalVisibility;
  const effectiveReplay = replay ?? (archivedSelf
    ? {
        memoryBase: archivedSelf.memoryBase,
        tableBase: archivedSelf.tableBase,
        activationId: archivedSelf.activationId,
        tlsBase: archivedSelf.tlsBase,
        globalVisibility: archivedSelf.globalVisibility,
        committedGlobalRoot: archivedSelf.committedGlobalRoot,
        providerDependencies: archivedSelf.providerDependencies,
        allocations: archivedSelf.allocations,
        initializationStage: archivedSelf.initialization?.stage,
      }
    : undefined);
  const dependencyScope: LoadedSharedLibrary[] = [];
  appendDependencyScope(
    dependencyScope,
    metadata.neededDynlibs.map((dependencyName) => {
      const dependency = options.loadedLibraries.get(dependencyName);
      if (!dependency) {
        throw new Error(`${name}: loaded dependency ${dependencyName} is missing`);
      }
      return dependency;
    }),
    options,
  );
  return yield* instantiateSharedLibrarySteps(
    name,
    wasmBytes,
    metadata,
    options,
    effectiveReplay,
    loadContext,
    effectiveGlobalVisibility,
    dependencyScope,
  );
}

export function loadSharedLibrarySync(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
  globalVisibility = true,
): LoadedSharedLibrary {
  return driveDylinkInitialization(
    loadSharedLibrarySyncSteps(
      name,
      wasmBytes,
      options,
      replay,
      undefined,
      undefined,
      globalVisibility,
    ),
  );
}

/**
 * Manages dynamic linking state for a single process. Provides the dlopen/dlsym/
 * dlclose API that maps to C runtime calls.
 */
export class DynamicLinker {
  private static readonly MAIN_PROGRAM_HANDLE = 1;
  private options: LoadSharedLibraryOptions;
  private handleCounter = DynamicLinker.MAIN_PROGRAM_HANDLE + 1;
  private handleMap = new Map<number, LoadedSharedLibrary>();
  private libraryHandles = new Map<string, number>();
  private handleRefCounts = new Map<number, number>();
  /** One retain per live consumer -> immutable or runtime provider edge. */
  private dependencyRetainCounts = new Map<string, number>();
  /** Consumers whose immutable NEEDED edges have been accounted exactly once. */
  private dependencyOwners = new Set<string>();
  private pendingTokenCounter = 1;
  private pendingDlopens = new Map<number, PendingDlopenTransaction>();
  private lastError: string | null = null;
  private readonly baseGlobalSymbols: Map<
    string,
    Function | WebAssembly.Global
  >;
  private readonly baseGlobalSymbolOwners: Map<string, string | undefined>;
  private readonly baseGot: Map<string, WebAssembly.Global>;

  constructor(options: LoadSharedLibraryOptions) {
    validateLongjmpConfiguration(options);
    this.options = options;
    this.options.gotKinds ??= new Map();
    const owners = symbolOwners(this.options);
    this.baseGlobalSymbols = new Map(options.globalSymbols);
    this.baseGlobalSymbolOwners = new Map(owners);
    this.baseGot = new Map(options.got);
  }

  private stateForLibrary(lib: LoadedSharedLibrary): DylinkForkLibraryState {
    const providerDependencies = [...(lib.providerDependencies ?? [])]
      .filter((dependency) => dependency !== lib.name)
      .sort();
    const providerState = providerDependencies.length === 0
      ? {}
      : { providerDependencies };
    const allocations = (lib.allocations ?? []).map((allocation, index) =>
      copyForkMemoryAllocation(
        allocation,
        `${lib.name}: live allocation ${index}`,
      )
    );
    const allocationState = allocations.length === 0
      ? {}
      : { allocations };
    const handle = this.libraryHandles.get(lib.name);
    if (handle === undefined) {
      return {
        name: lib.name,
        moduleBytes: lib.moduleBytes,
        memoryBase: lib.memoryBase,
        tableBase: lib.tableBase,
        activationId: lib.activationId,
        tlsBase: lib.tlsBase,
        globalVisibility: lib.globalVisibility,
        ...(lib.committedGlobalRoot
          ? { committedGlobalRoot: true }
          : {}),
        ...providerState,
        ...allocationState,
        initialization: lib.initialization,
      };
    }
    if (this.handleMap.get(handle) !== lib) {
      throw new Error(
        `${lib.name}: dynamic-linker fork state points at a different instance`,
      );
    }
    const refCount = this.handleRefCounts.get(handle);
    if (!Number.isInteger(refCount) || refCount! <= 0) {
      throw new Error(
        `${lib.name}: dynamic-linker fork state has invalid handle refcount`,
      );
    }
    return {
      name: lib.name,
      moduleBytes: lib.moduleBytes,
      memoryBase: lib.memoryBase,
      tableBase: lib.tableBase,
      activationId: lib.activationId,
      tlsBase: lib.tlsBase,
      globalVisibility: lib.globalVisibility,
      ...(lib.committedGlobalRoot
        ? { committedGlobalRoot: true }
        : {}),
      ...providerState,
      ...allocationState,
      handle,
      refCount,
      initialization: lib.initialization,
    };
  }

  /** O(1) lookup for incrementally updating one live-module archive record. */
  forkLibraryState(name: string): DylinkForkLibraryState | undefined {
    const lib = this.options.loadedLibraries.get(name);
    return lib ? this.stateForLibrary(lib) : undefined;
  }

  /**
   * Read the compact live process state; closed modules and historical events
   * are deliberately absent so archive size is bounded by the live closure.
   */
  forkState(): DylinkForkState {
    const transactions = Array.from(
      this.pendingDlopens.values(),
      (transaction): DylinkForkTransactionState => ({
        token: transaction.token,
        name: transaction.name,
        moduleBytes: transaction.moduleBytes,
        globalVisibility: transaction.globalVisibility,
      }),
    );
    return {
      nextHandle: this.handleCounter,
      libraries: Array.from(
        this.options.loadedLibraries.values(),
        (lib) => this.stateForLibrary(lib),
      ),
      ...(transactions.length === 0 ? {} : { transactions }),
    };
  }

  /**
   * Materialize every archived module recipe into this Worker's table graph.
   *
   * This does not recreate user-visible dlopen handles: pthread replicas need
   * callable functions and activation catalogs, while the process-wide handle
   * snapshot remains owned by the archive/main API. Existing instances are
   * verified rather than re-instantiated, so a generation check makes the
   * steady-state path O(1).
   */
  reconcileForkModules(
    state: DylinkForkState,
    options: DylinkForkReconcileOptions = {},
  ): void {
    const memoryOwnership = options.memoryOwnership ?? "copied";
    if (
      memoryOwnership === "borrowed"
      && (
        (state.transactions?.length ?? 0) !== 0
        || state.libraries.some((library) => library.initialization !== undefined)
      )
    ) {
      // An issued bootstrap/relocation/constructor entry is guest code that
      // may mutate arbitrary process memory. A later vfork design can resume
      // it only with a stronger write-isolation contract.
      throw new Error(
        "borrowed dynamic-linker replay cannot restore an in-flight dlopen transaction",
      );
    }
    const archivedNames = new Set<string>();
    let visibilityChanged = false;
    let dependencyStateChanged = false;
    for (const archived of state.libraries) {
      if (archivedNames.has(archived.name)) {
        throw new Error(
          `${archived.name}: duplicate module in dynamic-linker table recipe state`,
        );
      }
      archivedNames.add(archived.name);
      const live = this.options.loadedLibraries.get(archived.name);
      if (live) {
        // The immutable instance recipe must never drift, but a peer
        // publication can legitimately advance TLS discovery and the issued
        // initializer while this Worker's generator is suspended.
        this.requireForkLibraryIdentity(live, archived, true);
        if (
          live.globalVisibility !== archived.globalVisibility
          || live.committedGlobalRoot !== archived.committedGlobalRoot
        ) {
          live.globalVisibility = archived.globalVisibility;
          live.committedGlobalRoot = archived.committedGlobalRoot;
          visibilityChanged = true;
        }
        const liveProviders = [...(live.providerDependencies ?? [])].sort();
        const archivedProviders = [...(archived.providerDependencies ?? [])]
          .sort();
        if (
          liveProviders.length !== archivedProviders.length
          || liveProviders.some(
            (dependency, index) => dependency !== archivedProviders[index],
          )
        ) {
          live.providerDependencies = new Set(archivedProviders);
          dependencyStateChanged = true;
        }
      }
    }
    if (visibilityChanged) this.rebuildRuntimeIndexes();

    this.restorePendingDlopenTransactions(state);

    // A pthread Worker can observe dlclose after it materialized an earlier
    // generation. Remove consumers before providers, clear their exact table
    // slots, and release activation-owned reference catalogs before loading
    // anything from the new authoritative closure.
    const stale = [...this.options.loadedLibraries.values()]
      .filter((lib) => !archivedNames.has(lib.name))
      .reverse();
    for (const lib of stale) {
      const handle = this.libraryHandles.get(lib.name);
      if (handle !== undefined) {
        this.handleMap.delete(handle);
        this.handleRefCounts.delete(handle);
        this.libraryHandles.delete(lib.name);
      }
      this.clearLibraryTableEntries(lib);
      this.options.loadedLibraries.delete(lib.name);
      lib.unregisterForkActivation?.();
      for (const allocation of lib.allocations ?? []) {
        // The publishing pthread already performed munmap. This replica only
        // drops the copied Worker-local allocator index.
        this.options.forgetMemoryAllocation?.(allocation);
      }
      lib.allocations = [];
    }
    if (stale.length > 0) {
      this.rebuildRuntimeIndexes();
    }

    for (const archived of state.libraries) {
      if (this.options.loadedLibraries.has(archived.name)) continue;
      if (archived.initialization !== undefined) continue;
      this.loadModuleSync(
        archived.name,
        new Uint8Array(archived.moduleBytes),
        {
          memoryBase: archived.memoryBase,
          tableBase: archived.tableBase,
          activationId: archived.activationId,
          tlsBase: archived.tlsBase,
          globalVisibility: archived.globalVisibility,
          committedGlobalRoot: archived.committedGlobalRoot,
          providerDependencies: archived.providerDependencies,
          allocations: archived.allocations,
          memoryOwnership,
        },
        archived.globalVisibility,
        false,
      );
    }
    // Replay can restore a constructor-created provider edge whose provider
    // appears later in insertion order. Account lifetimes only after the exact
    // module closure has been materialized.
    this.rebuildDependencyBookkeeping();
    if (dependencyStateChanged) this.rebuildRuntimeIndexes();
    for (const archived of state.libraries) {
      const live = this.options.loadedLibraries.get(archived.name);
      if (!live) {
        throw new Error(
          `${archived.name}: dynamic-linker reconciliation lost its live instance`,
        );
      }
      this.requireForkLibraryIdentity(live, archived);
    }
  }

  private restorePendingDlopenTransactions(state: DylinkForkState): void {
    const transactions = state.transactions ?? [];
    const archivedModules = new Map(
      state.libraries.map((library) => [library.name, library]),
    );
    const transactionStates = new Map<number, DylinkForkTransactionState>();
    const activeStates = new Map<number, DylinkForkLibraryState>();
    for (const transaction of transactions) {
      if (transactionStates.has(transaction.token)) {
        throw new Error(
          `duplicate staged dlopen transaction ${transaction.token}`,
        );
      }
      transactionStates.set(transaction.token, transaction);
    }
    for (const library of state.libraries) {
      const initialization = library.initialization;
      if (!initialization) continue;
      if (!transactionStates.has(initialization.transactionToken)) {
        throw new Error(
          `${library.name}: issued initializer names missing staged dlopen `
          + `transaction ${initialization.transactionToken}`,
        );
      }
      if (activeStates.has(initialization.transactionToken)) {
        throw new Error(
          `staged dlopen transaction ${initialization.transactionToken} has `
          + "multiple issued entries",
        );
      }
      activeStates.set(initialization.transactionToken, library);
    }
    for (const transaction of transactions) {
      if (!activeStates.has(transaction.token)) {
        throw new Error(
          `staged dlopen transaction ${transaction.token} has no issued entry`,
        );
      }
    }

    const bytesEqual = (
      left: Readonly<Uint8Array>,
      right: Readonly<Uint8Array>,
    ): boolean =>
      left.length === right.length
      && left.every((byte, index) => byte === right[index]);
    const clearIssuedMarker = (
      transaction: PendingDlopenTransaction,
    ): void => {
      const current = transaction.currentStep;
      if (!current) return;
      const live = this.options.loadedLibraries.get(current.libraryName);
      if (
        live?.initialization?.transactionToken === transaction.token
      ) {
        delete live.initialization;
      }
      transaction.currentStep = undefined;
      transaction.awaitingCompletion = false;
    };
    const clearTransactionTableEntry = (
      transaction: PendingDlopenTransaction,
    ): void => {
      if (transaction.tableIndex === undefined) return;
      setTableEntry(this.options.table, transaction.tableIndex, null);
      this.options.onTableMutation?.(
        this.options.table,
        transaction.tableIndex,
        1,
      );
    };
    const installIssuedStep = (
      transaction: PendingDlopenTransaction,
      archived: DylinkForkLibraryState,
    ): void => {
      const initialization = archived.initialization;
      const current = transaction.currentStep;
      if (
        !initialization
        || !current
        || current.libraryName !== archived.name
        || current.stage !== initialization.stage
        || transaction.tableIndex !== initialization.tableIndex
      ) {
        throw new Error(
          `staged dlopen transaction ${transaction.token} could not `
          + `reconstruct ${archived.name}:${initialization?.stage ?? "none"}`,
        );
      }
      const tableLengthBefore = tableLength(this.options.table);
      if (tableLengthBefore <= initialization.tableIndex) {
        growTable(
          this.options.table,
          initialization.tableIndex + 1 - tableLengthBefore,
        );
      }
      setTableEntry(
        this.options.table,
        initialization.tableIndex,
        current.invoke as unknown as Function,
      );
      this.options.onTableMutation?.(
        this.options.table,
        initialization.tableIndex,
        1,
      );
      const provisional = this.options.loadedLibraries.get(archived.name);
      if (!provisional || provisional.loadState !== "initializing") {
        throw new Error(
          `${archived.name}: staged dlopen replay lost its provisional module`,
        );
      }
      provisional.providerDependencies = new Set(
        archived.providerDependencies ?? [],
      );
      provisional.initialization = Object.freeze({ ...initialization });
      transaction.awaitingCompletion = true;
    };
    const refreshReplayModules = (
      transaction: PendingDlopenTransaction,
    ): void => {
      if (!transaction.replayModules) return;
      transaction.replayModules.clear();
      for (const [name, library] of archivedModules) {
        transaction.replayModules.set(name, library);
      }
    };
    const advanceWithoutGuestCalls = (
      transaction: PendingDlopenTransaction,
      target?: DylinkForkLibraryState,
    ): void => {
      refreshReplayModules(transaction);
      for (;;) {
        if (
          target
          && transaction.currentStep?.libraryName === target.name
          && transaction.currentStep.stage === target.initialization?.stage
        ) {
          installIssuedStep(transaction, target);
          return;
        }

        const completedStep = transaction.currentStep;
        const resumeState = completedStep
          ? archivedModules.get(completedStep.libraryName)
          : undefined;
        clearIssuedMarker(transaction);
        const cursor = transaction.steps.next(resumeState);
        if (cursor.done) {
          transaction.loaded = cursor.value;
          clearTransactionTableEntry(transaction);
          if (target) {
            throw new Error(
              `${target.name}: staged dlopen replay could not reach `
              + `${target.initialization?.stage ?? "an issued step"}`,
            );
          }
          return;
        }
        transaction.currentStep = cursor.value;
        transaction.awaitingCompletion = true;
      }
    };
    const discardRolledBackTransaction = (
      transaction: PendingDlopenTransaction,
    ): void => {
      clearIssuedMarker(transaction);
      clearTransactionTableEntry(transaction);
      try {
        transaction.steps.throw(
          new Error(
            `${transaction.name}: peer publication rolled back staged dlopen`,
          ),
        );
      } catch {
        // The generator reports the synthetic rollback cause after releasing
        // its activation/table/symbol ownership. The authoritative archive
        // state, not that local exception, determines reconciliation.
      }
    };

    for (const transaction of [...this.pendingDlopens.values()]) {
      const archivedTransaction = transactionStates.get(transaction.token);
      if (!archivedTransaction) {
        const committed = archivedModules.get(transaction.name);
        if (committed?.handle !== undefined) {
          advanceWithoutGuestCalls(transaction);
        } else {
          discardRolledBackTransaction(transaction);
        }
        this.pendingDlopens.delete(transaction.token);
        continue;
      }
      if (
        transaction.name !== archivedTransaction.name
        || transaction.globalVisibility !== archivedTransaction.globalVisibility
        || !bytesEqual(transaction.moduleBytes, archivedTransaction.moduleBytes)
      ) {
        throw new Error(
          `staged dlopen transaction ${transaction.token} changed identity`,
        );
      }
      const target = activeStates.get(transaction.token)!;
      if (
        transaction.tableIndex !== undefined
        && transaction.tableIndex !== target.initialization!.tableIndex
      ) {
        throw new Error(
          `staged dlopen transaction ${transaction.token} changed its `
          + "initialization table slot",
        );
      }
      transaction.tableIndex ??= target.initialization!.tableIndex;
      advanceWithoutGuestCalls(transaction, target);
    }

    for (const transactionState of transactions) {
      if (this.pendingDlopens.has(transactionState.token)) continue;
      const archived = activeStates.get(transactionState.token)!;
      const initialization = archived.initialization!;
      for (const prior of state.libraries) {
        if (prior.name === archived.name) break;
        if (
          this.options.loadedLibraries.has(prior.name)
          || prior.initialization !== undefined
        ) {
          continue;
        }
        this.loadModuleSync(
          prior.name,
          new Uint8Array(prior.moduleBytes),
          {
            memoryBase: prior.memoryBase,
            tableBase: prior.tableBase,
            activationId: prior.activationId,
            tlsBase: prior.tlsBase,
            globalVisibility: prior.globalVisibility,
            committedGlobalRoot: prior.committedGlobalRoot,
            providerDependencies: prior.providerDependencies,
            allocations: prior.allocations,
          },
          prior.globalVisibility,
          false,
        );
      }
      const replayModules = new Map(archivedModules);
      const initialLibraries = new Set(this.options.loadedLibraries.values());
      const ownedLibraries = new Set<LoadedSharedLibrary>();
      const steps = loadSharedLibrarySyncSteps(
        transactionState.name,
        new Uint8Array(transactionState.moduleBytes),
        this.options,
        undefined,
        replayModules,
        { ownedLibraries },
        transactionState.globalVisibility,
      );
      const cursor = steps.next();
      if (cursor.done) {
        throw new Error(
          `${archived.name}: staged dlopen replay completed before `
          + `${initialization.stage}`,
        );
      }
      const tableLengthBefore = tableLength(this.options.table);
      if (tableLengthBefore <= initialization.tableIndex) {
        growTable(
          this.options.table,
          initialization.tableIndex + 1 - tableLengthBefore,
        );
      }
      const pending: PendingDlopenTransaction = {
        token: transactionState.token,
        name: transactionState.name,
        moduleBytes: new Uint8Array(transactionState.moduleBytes),
        globalVisibility: transactionState.globalVisibility,
        steps,
        replayModules,
        initialLibraries,
        initialVisibility: new Map(
          Array.from(
            initialLibraries,
            (library) => [library, library.globalVisibility],
          ),
        ),
        ownedLibraries,
        initialHeapPointer: this.options.heapPointer?.value,
        tableIndex: initialization.tableIndex,
        awaitingCompletion: true,
        currentStep: cursor.value,
      };
      advanceWithoutGuestCalls(pending, archived);
      this.pendingDlopens.set(transactionState.token, pending);
      this.pendingTokenCounter = Math.max(
        this.pendingTokenCounter,
        transactionState.token + 1,
      );
    }
  }

  /**
   * Restore the compact user-visible handle index after every archived module
   * has been instantiated dependency-first.
   *
   * WHY: module-load order and dlopen-handle order are different domains.
   * Dependencies are instantiated before their consumers, while handles are
   * allocated only for explicit dlopen calls; final dlclose also leaves
   * permanent gaps in the monotonic handle sequence. Replaying synthetic
   * open/close events would either invent history or allocate the wrong next
   * handle. The copied snapshot is the reconstruction owner instead.
   */
  restoreForkHandleState(state: DylinkForkState): void {
    this.applyForkHandleState(state, true);
  }

  /**
   * Replace this Worker's local handle index with the process publication.
   *
   * Pthread Workers can observe many generations, so unlike one-shot child
   * replay this operation deliberately accepts an already populated index.
   */
  reconcileForkHandleState(state: DylinkForkState): void {
    this.applyForkHandleState(state, false);
  }

  private applyForkHandleState(
    state: DylinkForkState,
    requirePristine: boolean,
  ): void {
    if (
      requirePristine
      && (
      this.handleCounter !== DynamicLinker.MAIN_PROGRAM_HANDLE + 1
      || this.handleMap.size !== 0
      || this.libraryHandles.size !== 0
      || this.handleRefCounts.size !== 0
      )
    ) {
      throw new Error(
        "dynamic-linker fork handle state requires a pristine child handle index",
      );
    }
    if (
      !Number.isSafeInteger(state.nextHandle)
      || state.nextHandle < DynamicLinker.MAIN_PROGRAM_HANDLE + 1
      || state.nextHandle > 0x1_0000_0000
    ) {
      throw new RangeError(
        `dynamic-linker fork next handle ${String(state.nextHandle)} is invalid`,
      );
    }

    const liveByName = this.options.loadedLibraries;
    if (state.libraries.length !== liveByName.size) {
      throw new Error(
        "dynamic-linker fork state does not describe the exact live module closure",
      );
    }

    const restoredHandles = new Map<number, LoadedSharedLibrary>();
    const restoredLibraryHandles = new Map<string, number>();
    const restoredRefCounts = new Map<number, number>();
    const seenNames = new Set<string>();
    for (const archived of state.libraries) {
      if (seenNames.has(archived.name)) {
        throw new Error(
          `${archived.name}: duplicate module in dynamic-linker fork state`,
        );
      }
      seenNames.add(archived.name);
      const live = liveByName.get(archived.name);
      if (!live) {
        throw new Error(
          `${archived.name}: dynamic-linker fork state has no live replay instance`,
        );
      }
      this.requireForkLibraryIdentity(live, archived);

      const hasHandle = archived.handle !== undefined;
      if (hasHandle !== (archived.refCount !== undefined)) {
        throw new Error(
          `${archived.name}: dynamic-linker fork handle/refcount presence is inconsistent`,
        );
      }
      if (!hasHandle) continue;
      const handle = archived.handle!;
      const refCount = archived.refCount!;
      if (
        !Number.isInteger(handle)
        || handle <= DynamicLinker.MAIN_PROGRAM_HANDLE
        || handle >= state.nextHandle
        || handle > 0xffff_ffff
      ) {
        throw new RangeError(
          `${archived.name}: dynamic-linker fork handle ${String(handle)} is invalid`,
        );
      }
      if (!Number.isInteger(refCount) || refCount <= 0 || refCount > 0xffff_ffff) {
        throw new RangeError(
          `${archived.name}: dynamic-linker fork refcount ${String(refCount)} is invalid`,
        );
      }
      if (restoredHandles.has(handle)) {
        throw new Error(
          `${archived.name}: duplicate dynamic-linker fork handle ${handle}`,
        );
      }
      restoredHandles.set(handle, live);
      restoredLibraryHandles.set(archived.name, handle);
      restoredRefCounts.set(handle, refCount);
    }
    for (const name of liveByName.keys()) {
      if (!seenNames.has(name)) {
        throw new Error(
          `${name}: live replay module is missing from dynamic-linker fork state`,
        );
      }
    }

    this.handleMap = restoredHandles;
    this.libraryHandles = restoredLibraryHandles;
    this.handleRefCounts = restoredRefCounts;
    this.handleCounter = state.nextHandle;
    this.lastError = null;
  }

  private requireForkLibraryIdentity(
    live: LoadedSharedLibrary,
    archived: DylinkForkLibraryState,
    allowInitializationTransition = false,
  ): void {
    const liveProviders = [...(live.providerDependencies ?? [])].sort();
    const archivedProviders = [...(archived.providerDependencies ?? [])].sort();
    const liveAllocations = [...(live.allocations ?? [])];
    const archivedAllocations = [...(archived.allocations ?? [])];
    if (
      live.memoryBase !== archived.memoryBase
      || live.tableBase !== archived.tableBase
      || live.activationId !== archived.activationId
      || liveAllocations.length !== archivedAllocations.length
      || liveAllocations.some((allocation, index) => {
        const expected = archivedAllocations[index];
        return (
          expected === undefined
          || allocation.address !== expected.address
          || allocation.size !== expected.size
          || allocation.mappingAddress !== expected.mappingAddress
          || allocation.mappingSize !== expected.mappingSize
        );
      })
      || (
        !allowInitializationTransition
        && (
          live.globalVisibility !== archived.globalVisibility
          || live.committedGlobalRoot !== archived.committedGlobalRoot
          || liveProviders.length !== archivedProviders.length
          || liveProviders.some(
            (dependency, index) => dependency !== archivedProviders[index],
          )
          || live.tlsBase !== archived.tlsBase
          || live.initialization?.transactionToken
            !== archived.initialization?.transactionToken
          || live.initialization?.stage !== archived.initialization?.stage
          || live.initialization?.tableIndex
            !== archived.initialization?.tableIndex
          || (live.loadState === "initializing")
            !== (archived.initialization !== undefined)
        )
      )
      || live.moduleBytes.length !== archived.moduleBytes.length
      || !live.moduleBytes.every(
        (byte, index) => byte === archived.moduleBytes[index],
      )
    ) {
      throw new Error(
        `${archived.name}: dynamic-linker replay instance does not match its fork state`,
      );
    }
  }

  /** Return the stable opaque handle used by dlopen(NULL, ...). */
  dlopenMain(): number {
    this.lastError = null;
    return DynamicLinker.MAIN_PROGRAM_HANDLE;
  }

  /**
   * Begin one process-driven dlopen transaction without entering guest code.
   *
   * The returned token is private to libc's prepare/next/commit loop and is
   * never exposed as a user-visible dlopen handle.
   */
  beginDlopenSync(
    name: string,
    wasmBytes: Uint8Array,
    globalVisibility = true,
  ): number {
    try {
      const token = requireNonzeroU32(
        this.pendingTokenCounter,
        `${name}: next staged dlopen token`,
      );
      if (token === 0xffff_ffff) {
        throw new RangeError(`${name}: staged dlopen token space is exhausted`);
      }
      this.pendingTokenCounter = token + 1;
      const ownedBytes = wasmBytes.slice();
      const initialLibraries = new Set(this.options.loadedLibraries.values());
      const initialVisibility = new Map(
        Array.from(
          initialLibraries,
          (library) => [library, library.globalVisibility],
        ),
      );
      const ownedLibraries = new Set<LoadedSharedLibrary>();
      this.pendingDlopens.set(token, {
        token,
        name,
        moduleBytes: ownedBytes,
        globalVisibility,
        steps: loadSharedLibrarySyncSteps(
          name,
          ownedBytes,
          this.options,
          undefined,
          undefined,
          { ownedLibraries },
          globalVisibility,
        ),
        initialLibraries,
        initialVisibility,
        ownedLibraries,
        initialHeapPointer: this.options.heapPointer?.value,
        awaitingCompletion: false,
      });
      this.lastError = null;
      return token;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return 0;
    }
  }

  /**
   * Acknowledge the previously returned `() -> ()` entry and select the next.
   *
   * Zero means initialization is complete. The selected function remains
   * rooted in one transaction-owned table slot until the following call.
   */
  nextDlopenInitialization(token: number): number {
    const transaction = this.pendingDlopens.get(token);
    if (!transaction) {
      this.lastError = `invalid staged dlopen token ${String(token)}`;
      return -1;
    }
    try {
      if (transaction.currentStep) {
        const previous = this.options.loadedLibraries.get(
          transaction.currentStep.libraryName,
        );
        if (
          previous?.initialization?.transactionToken === transaction.token
        ) {
          delete previous.initialization;
        }
        transaction.currentStep = undefined;
      }
      transaction.awaitingCompletion = false;
      const cursor = transaction.steps.next();
      if (cursor.done) {
        transaction.loaded = cursor.value;
        if (transaction.tableIndex !== undefined) {
          setTableEntry(this.options.table, transaction.tableIndex, null);
          this.options.onTableMutation?.(
            this.options.table,
            transaction.tableIndex,
            1,
          );
        }
        this.lastError = null;
        return 0;
      }

      let index = transaction.tableIndex;
      if (index === undefined) {
        index = tableLength(this.options.table);
        if (index === 0) {
          growTable(this.options.table, 1);
          index = 1;
        }
        growTable(this.options.table, 1);
        transaction.tableIndex = index;
      }
      if (!Number.isSafeInteger(index) || index <= 0 || index > 0x7fff_ffff) {
        throw new RangeError(
          `${transaction.name}: initialization table index ${String(index)} is invalid`,
        );
      }
      setTableEntry(
        this.options.table,
        index,
        cursor.value.invoke as unknown as Function,
      );
      this.options.onTableMutation?.(this.options.table, index, 1);
      transaction.awaitingCompletion = true;
      transaction.currentStep = cursor.value;
      const provisional = this.options.loadedLibraries.get(
        cursor.value.libraryName,
      );
      if (!provisional || provisional.loadState !== "initializing") {
        throw new Error(
          `${cursor.value.libraryName}: initialization step has no provisional module`,
        );
      }
      provisional.initialization = Object.freeze({
        transactionToken: token,
        stage: cursor.value.stage,
        tableIndex: index,
      });
      this.lastError = null;
      return index;
    } catch (error) {
      this.abortDlopenTransaction(token, error);
      return -1;
    }
  }

  /**
   * Advance one staged load and atomically publish its public handle on finish.
   *
   * The process import uses this combined transition so no guest instruction
   * can observe a completed generator whose transaction is still archived as
   * an issued initializer. The separate next/commit methods remain useful to
   * standalone embedders and focused state-machine tests.
   */
  advanceDlopenSync(token: number): Readonly<{
    entry: number;
    handle: number;
  }> {
    const entry = this.nextDlopenInitialization(token);
    if (entry !== 0) return { entry, handle: 0 };
    const handle = this.commitDlopenSync(token);
    return handle > 0
      ? { entry: 0, handle }
      : { entry: -1, handle: 0 };
  }

  hasPendingDlopen(token: number): boolean {
    return this.pendingDlopens.has(token);
  }

  /** Commit the fully initialized module closure and return its stable handle. */
  commitDlopenSync(token: number): number {
    const transaction = this.pendingDlopens.get(token);
    if (!transaction) {
      this.lastError = `invalid staged dlopen token ${String(token)}`;
      return 0;
    }
    if (transaction.awaitingCompletion || !transaction.loaded) {
      this.lastError =
        `${transaction.name}: staged dlopen committed before initialization completed`;
      return 0;
    }
    try {
      this.registerDependencyEdges();
      if (transaction.globalVisibility) {
        promoteLibraryGlobal(transaction.loaded, this.options);
        transaction.loaded.committedGlobalRoot = true;
        refreshGlobalGotEntries(this.options);
      }
      const handle = this.openLoadedLibrary(transaction.loaded);
      this.pendingDlopens.delete(token);
      this.lastError = null;
      return handle;
    } catch (error) {
      this.abortDlopenTransaction(token, error);
      return 0;
    }
  }

  private rollbackDlopenLibraries(
    transaction: PendingDlopenTransaction,
  ): unknown[] {
    const failures: unknown[] = [];
    const rolledBack = new Set(transaction.ownedLibraries);
    const invalidNames = new Set(
      Array.from(rolledBack, (library) => library.name),
    );
    const loadedNow = [...this.options.loadedLibraries.values()];

    // A constructor can complete a nested, independent dlopen before its outer
    // initializer fails. Keep that nested transaction unless it captured an
    // outer symbol or has a NEEDED edge into the failed closure.
    let changed = true;
    while (changed) {
      changed = false;
      for (const library of loadedNow) {
        if (
          transaction.initialLibraries.has(library)
          || rolledBack.has(library)
        ) {
          continue;
        }
        const dependsOnInvalid = [
          ...library.metadata.neededDynlibs,
          ...(library.providerDependencies ?? []),
        ].some((dependency) => invalidNames.has(dependency));
        if (!dependsOnInvalid) continue;
        rolledBack.add(library);
        invalidNames.add(library.name);
        changed = true;
      }
    }

    for (const library of loadedNow.reverse()) {
      if (
        !rolledBack.has(library)
        || this.options.loadedLibraries.get(library.name) !== library
      ) {
        continue;
      }
      const handle = this.libraryHandles.get(library.name);
      if (handle !== undefined) {
        this.handleMap.delete(handle);
        this.handleRefCounts.delete(handle);
        this.libraryHandles.delete(library.name);
      }
      try {
        this.clearLibraryTableEntries(library);
      } catch (error) {
        failures.push(error);
      }
      this.options.loadedLibraries.delete(library.name);
      try {
        library.unregisterForkActivation?.();
      } catch (error) {
        failures.push(error);
      }
      if (this.options.deallocateMemory) {
        for (const allocation of [...(library.allocations ?? [])].reverse()) {
          try {
            this.options.deallocateMemory(
              allocation.address,
              allocation.size,
            );
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    transaction.ownedLibraries.clear();

    if (
      this.options.heapPointer
      && transaction.initialHeapPointer !== undefined
    ) {
      let retainedEnd = transaction.initialHeapPointer;
      for (const library of this.options.loadedLibraries.values()) {
        if (transaction.initialLibraries.has(library)) continue;
        retainedEnd = Math.max(
          retainedEnd,
          library.heapReservationEnd ?? retainedEnd,
        );
      }
      this.options.heapPointer.value = retainedEnd;
    }
    // Undo visibility changes made by this transaction, then reapply the
    // closure of independently committed GLOBAL roots that survived it.
    for (const [library, visibility] of transaction.initialVisibility) {
      if (this.options.loadedLibraries.get(library.name) === library) {
        library.globalVisibility = visibility;
      }
    }
    for (const library of this.options.loadedLibraries.values()) {
      if (library.committedGlobalRoot) {
        promoteLibraryGlobal(library, this.options);
      }
    }
    try {
      this.rebuildDependencyBookkeeping();
      this.rebuildRuntimeIndexes();
    } catch (error) {
      failures.push(error);
    }
    return failures;
  }

  abortDlopenTransaction(token: number, cause?: unknown): void {
    const transaction = this.pendingDlopens.get(token);
    if (!transaction) return;
    this.pendingDlopens.delete(token);
    if (transaction.currentStep) {
      const provisional = this.options.loadedLibraries.get(
        transaction.currentStep.libraryName,
      );
      if (
        provisional?.initialization?.transactionToken === transaction.token
      ) {
        delete provisional.initialization;
      }
    }
    let failure = cause;
    if (transaction.tableIndex !== undefined) {
      try {
        setTableEntry(this.options.table, transaction.tableIndex, null);
        this.options.onTableMutation?.(
          this.options.table,
          transaction.tableIndex,
          1,
        );
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      transaction.steps.throw(
        cause ?? new Error(`${transaction.name}: staged dlopen aborted`),
      );
    } catch (error) {
      failure ??= error;
    }
    const rollbackFailures = this.rollbackDlopenLibraries(transaction);
    if (rollbackFailures.length > 0) {
      failure = failure === undefined
        ? new AggregateError(
            rollbackFailures,
            `${transaction.name}: staged dlopen rollback was incomplete`,
          )
        : new AggregateError(
            [failure, ...rollbackFailures],
            `${transaction.name}: staged dlopen rollback was incomplete`,
          );
    }
    this.lastError = failure instanceof Error
      ? failure.message
      : String(failure ?? "staged dlopen aborted");
  }

  /**
   * Instantiate one module without manufacturing a dlopen handle.
   *
   * Fork replay records module loads separately from user-visible open/close
   * events. This lets NEEDED dependencies be restored in exact parent order
   * without accidentally incrementing their handle counts.
   */
  loadModuleSync(
    name: string,
    wasmBytes: Uint8Array,
    replay?: DylinkReplayOptions,
    globalVisibility = replay?.globalVisibility ?? true,
    registerDependencies = true,
  ): LoadedSharedLibrary {
    const loaded = loadSharedLibrarySync(
      name,
      wasmBytes,
      this.options,
      replay,
      globalVisibility,
    );
    if (replay) {
      loaded.committedGlobalRoot = replay.committedGlobalRoot;
      loaded.providerDependencies = new Set(
        replay.providerDependencies ?? loaded.providerDependencies ?? [],
      );
    }
    if (registerDependencies) this.registerDependencyEdges();
    this.lastError = null;
    return loaded;
  }

  private registerDependencyEdges(): void {
    // loadedLibraries insertion order is dependency-first. Scanning only the
    // unaccounted suffix makes recursive dependency loads cheap while keeping
    // the relationship derivable from immutable dylink metadata.
    for (const lib of this.options.loadedLibraries.values()) {
      if (this.dependencyOwners.has(lib.name)) continue;
      for (const dependency of runtimeDependencyNames(lib)) {
        if (!this.options.loadedLibraries.has(dependency)) {
          throw new Error(
            `${lib.name}: loaded dependency ${dependency} has no live provider`,
          );
        }
        const retains = this.dependencyRetainCounts.get(dependency) ?? 0;
        if (retains >= 0xffff_ffff) {
          throw new RangeError(
            `${dependency}: dynamic-linker dependency retain count overflow`,
          );
        }
        this.dependencyRetainCounts.set(dependency, retains + 1);
      }
      this.dependencyOwners.add(lib.name);
    }
  }

  private rebuildDependencyBookkeeping(): void {
    this.dependencyRetainCounts.clear();
    this.dependencyOwners.clear();
    this.registerDependencyEdges();
  }

  private clearLibraryTableEntries(lib: LoadedSharedLibrary): void {
    const entries = [...new Set(lib.ownedTableEntries)]
      .sort((left, right) => left - right);
    const length = tableLength(this.options.table);
    for (const index of entries) {
      if (
        !Number.isSafeInteger(index)
        || index < 0
        || index >= length
      ) {
        throw new Error(
          `${lib.name}: owned table entry ${String(index)} is out of bounds`,
        );
      }
    }
    for (const index of entries) {
      setTableEntry(this.options.table, index, null);
    }
    for (let first = 0; first < entries.length;) {
      let end = first + 1;
      while (end < entries.length && entries[end] === entries[end - 1]! + 1) {
        end++;
      }
      this.options.onTableMutation?.(
        this.options.table,
        entries[first]!,
        entries[end - 1]! - entries[first]! + 1,
      );
      first = end;
    }
  }

  /**
   * Rebuild the loader-owned indexes from the exact live module closure.
   *
   * WHY: retaining an unloaded function in `globalSymbols`, a GOT cell, or a
   * process-table slot would keep a stale callable GC root even though the
   * archive no longer contains its activation recipe.
   */
  private rebuildRuntimeIndexes(): void {
    this.options.globalSymbols.clear();
    const owners = symbolOwners(this.options);
    owners.clear();
    for (const [name, value] of this.baseGlobalSymbols) {
      this.options.globalSymbols.set(name, value);
      owners.set(name, this.baseGlobalSymbolOwners.get(name));
    }
    for (const lib of this.options.loadedLibraries.values()) {
      if (!lib.globalVisibility) continue;
      for (const [name, value] of Object.entries(lib.exports)) {
        if (
          !isPublicDylinkExport(name, value)
          || this.options.globalSymbols.has(name)
        ) {
          continue;
        }
        this.options.globalSymbols.set(name, value);
        owners.set(name, lib.name);
      }
    }

    const previousGot = new Map(this.options.got);
    const liveGotKinds = new Map<string, "mem" | "func">();
    for (const lib of this.options.loadedLibraries.values()) {
      for (const { name, kind } of lib.gotImports) {
        const previous = liveGotKinds.get(name);
        if (previous !== undefined && previous !== kind) {
          throw new Error(
            `live GOT symbol ${name} is both ${previous} and ${kind}`,
          );
        }
        liveGotKinds.set(name, kind);
      }
    }
    for (const name of this.baseGot.keys()) {
      const kind = this.options.gotKinds!.get(name);
      if (kind !== undefined) liveGotKinds.set(name, kind);
    }

    this.options.got.clear();
    for (const [name, global] of this.baseGot) {
      this.options.got.set(name, global);
    }
    for (const name of liveGotKinds.keys()) {
      const global = previousGot.get(name);
      if (!global) {
        throw new Error(`live GOT symbol ${name} lost its Global cell`);
      }
      this.options.got.set(name, global);
    }
    for (const name of [...this.options.gotKinds!.keys()]) {
      if (!this.options.got.has(name)) this.options.gotKinds!.delete(name);
    }
    for (const [name, kind] of liveGotKinds) {
      this.options.gotKinds!.set(name, kind);
      const global = this.options.got.get(name)!;
      const symbol = this.options.globalSymbols.get(name);
      if (kind === "mem" && symbol instanceof WebAssembly.Global) {
        global.value = symbol.value;
        continue;
      }
      if (kind === "func" && typeof symbol === "function") {
        let index = -1;
        const length = tableLength(this.options.table);
        for (let candidate = 0; candidate < length; candidate++) {
          if (getTableEntry(this.options.table, candidate) === symbol) {
            index = candidate;
            break;
          }
        }
        if (index < 0) {
          index = length;
          growTable(this.options.table, 1);
          setTableEntry(this.options.table, index, symbol);
          this.options.onTableMutation?.(this.options.table, index, 1);
        }
        global.value = wasmAddress(
          index,
          this.options.ptrWidth ?? 4,
          `GOT.func.${name}`,
        );
        continue;
      }
      global.value = wasmAddress(
        0,
        this.options.ptrWidth ?? 4,
        `unresolved GOT.${kind}.${name}`,
      );
    }
  }

  private releaseUnretainedLibrary(lib: LoadedSharedLibrary): void {
    if (this.libraryHandles.has(lib.name)) return;
    if ((this.dependencyRetainCounts.get(lib.name) ?? 0) !== 0) return;
    if (this.options.loadedLibraries.get(lib.name) !== lib) return;

    for (const dependency of runtimeDependencyNames(lib)) {
      const retains = this.dependencyRetainCounts.get(dependency);
      if (!Number.isInteger(retains) || retains! <= 0) {
        throw new Error(
          `${lib.name}: dependency ${dependency} has no matching retain`,
        );
      }
    }
    // Remove the consumer before releasing its providers so recursive NEEDED
    // chains observe the exact remaining live closure.
    this.clearLibraryTableEntries(lib);
    this.options.loadedLibraries.delete(lib.name);
    this.dependencyOwners.delete(lib.name);
    lib.unregisterForkActivation?.();
    const releaseFailures: unknown[] = [];
    if (this.options.deallocateMemory) {
      for (const allocation of [...(lib.allocations ?? [])].reverse()) {
        try {
          this.options.deallocateMemory(allocation.address, allocation.size);
        } catch (error) {
          releaseFailures.push(error);
        }
      }
    }
    lib.allocations = [];
    for (const dependency of runtimeDependencyNames(lib)) {
      const retains = this.dependencyRetainCounts.get(dependency)!;
      if (retains === 1) this.dependencyRetainCounts.delete(dependency);
      else this.dependencyRetainCounts.set(dependency, retains! - 1);
      const provider = this.options.loadedLibraries.get(dependency);
      if (provider) {
        try {
          this.releaseUnretainedLibrary(provider);
        } catch (error) {
          releaseFailures.push(error);
        }
      }
    }
    if (releaseFailures.length !== 0) {
      throw new AggregateError(
        releaseFailures,
        `${lib.name}: final unload could not release every process mapping`,
      );
    }
  }

  private openLoadedLibrary(
    lib: LoadedSharedLibrary,
    replayHandle?: number,
  ): number {
    const existingHandle = this.libraryHandles.get(lib.name);
    if (existingHandle !== undefined) {
      if (this.handleMap.get(existingHandle) !== lib) {
        throw new Error(
          `${lib.name}: dynamic-linker handle index points at a different instance`,
        );
      }
      if (replayHandle !== undefined && replayHandle !== existingHandle) {
        throw new Error(
          `${lib.name}: replay open returned handle ${replayHandle}, `
          + `but the live handle is ${existingHandle}`,
        );
      }
      const references = this.handleRefCounts.get(existingHandle);
      if (
        !Number.isInteger(references)
        || references! <= 0
        || references! >= 0xffff_ffff
      ) {
        throw new Error(
          `${lib.name}: dynamic-linker handle ${existingHandle} has invalid refcount`,
        );
      }
      this.handleRefCounts.set(existingHandle, references! + 1);
      this.lastError = null;
      return existingHandle;
    }

    const handle = requireNonzeroU32(
      replayHandle ?? this.handleCounter,
      `${lib.name}: ${replayHandle === undefined ? "next" : "replay"} dlopen handle`,
    );
    if (handle !== this.handleCounter) {
      throw new Error(
        `${lib.name}: replay dlopen handle ${handle} does not match `
        + `next handle ${this.handleCounter}`,
      );
    }
    if (this.handleMap.has(handle)) {
      throw new Error(`${lib.name}: replay dlopen handle ${handle} is already in use`);
    }
    this.handleCounter = handle + 1;
    this.handleMap.set(handle, lib);
    this.libraryHandles.set(lib.name, handle);
    this.handleRefCounts.set(handle, 1);
    this.lastError = null;
    return handle;
  }

  /** Open a shared library. Returns a handle (>0) or 0 on error.
   *
   * New replay code must use `loadModuleSync` followed by `replayOpen`, because
   * copied guest state requires the parent's exact handle rather than a newly
   * allocated child handle. The replay option remains here only as a
   * layout-preserving convenience for non-archived embedders.
   */
  dlopenSync(
    name: string,
    wasmBytes: Uint8Array,
    replay?: DylinkReplayOptions,
    globalVisibility = true,
  ): number {
    try {
      const loaded = this.loadModuleSync(
        name,
        wasmBytes,
        replay,
        globalVisibility,
      );
      if (globalVisibility) {
        promoteLibraryGlobal(loaded, this.options);
        loaded.committedGlobalRoot = true;
        refreshGlobalGotEntries(this.options);
      }
      return this.openLoadedLibrary(loaded);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return 0;
    }
  }

  /**
   * Replay one successful parent dlopen event after its module-load event.
   *
   * The exact returned handle is part of process state: guest code may retain
   * it in copied memory. A mismatch therefore rejects replay instead of
   * silently allocating a child-local replacement.
   */
  replayOpen(name: string, exactHandle: number): number {
    const lib = this.options.loadedLibraries.get(name);
    if (!lib) {
      throw new Error(`${name}: replay dlopen requires a prior module-load event`);
    }
    return this.openLoadedLibrary(lib, exactHandle);
  }

  private symbolAddress(
    symbolName: string,
    exp: Function | WebAssembly.Global | undefined,
  ): number | null {
    if (typeof exp === "function") {
      // Return the table index for this function (C function pointers are table indices)
      const table = this.options.table;
      const length = tableLength(table);
      for (let i = 0; i < length; i++) {
        if (getTableEntry(table, i) === exp) {
          this.lastError = null;
          return i;
        }
      }
      // Not in table yet — add it
      const idx = length;
      growTable(table, 1);
      setTableEntry(table, idx, exp as unknown as Function);
      this.options.onTableMutation?.(table, idx, 1);
      this.lastError = null;
      return idx;
    }

    if (exp instanceof WebAssembly.Global) {
      this.lastError = null;
      return Number(exp.value);
    }

    this.lastError = `symbol not found: ${symbolName}`;
    return null;
  }

  private recordConstructorProvider(owner: string | undefined): void {
    if (owner === undefined) return;
    const active = [...this.pendingDlopens.values()]
      .reverse()
      .find((transaction) =>
        transaction.currentStep?.stage === "constructors"
      );
    const consumerName = active?.currentStep?.libraryName;
    if (!consumerName || consumerName === owner) return;
    const consumer = this.options.loadedLibraries.get(consumerName);
    if (!consumer) return;
    const dependencies = consumer.providerDependencies instanceof Set
      ? consumer.providerDependencies
      : new Set(consumer.providerDependencies ?? []);
    dependencies.add(owner);
    consumer.providerDependencies = dependencies;
  }

  /** Look up a symbol by name. Returns its function-table index or data address. */
  dlsym(handle: number, symbolName: string): number | null {
    if (isForkRuntimeExport(symbolName)) {
      this.lastError = `symbol not found: ${symbolName}`;
      return null;
    }
    if (handle === DynamicLinker.MAIN_PROGRAM_HANDLE || handle === 0) {
      this.recordConstructorProvider(
        symbolOwners(this.options).get(symbolName),
      );
      return this.symbolAddress(
        symbolName,
        this.options.globalSymbols.get(symbolName),
      );
    }

    const lib = this.handleMap.get(handle);
    if (!lib) {
      this.lastError = "invalid handle";
      return null;
    }

    const scope: LoadedSharedLibrary[] = [];
    const seen = new Set<string>();
    const queue = [lib];
    for (let index = 0; index < queue.length; index++) {
      const candidate = queue[index]!;
      if (seen.has(candidate.name)) continue;
      seen.add(candidate.name);
      scope.push(candidate);
      for (const dependencyName of candidate.metadata.neededDynlibs) {
        const dependency = this.options.loadedLibraries.get(dependencyName);
        if (dependency && !seen.has(dependency.name)) queue.push(dependency);
      }
    }
    for (const candidate of scope) {
      const exp = candidate.exports[symbolName];
      if (typeof exp !== "function" && !(exp instanceof WebAssembly.Global)) {
        continue;
      }
      this.recordConstructorProvider(candidate.name);
      return this.symbolAddress(symbolName, exp);
    }
    this.lastError = `symbol not found: ${symbolName}`;
    return null;
  }

  private closeHandle(handle: number): void {
    if (handle === DynamicLinker.MAIN_PROGRAM_HANDLE) {
      this.lastError = null;
      return;
    }
    const lib = this.handleMap.get(handle);
    if (!lib) {
      throw new Error(`invalid dlopen handle ${handle}`);
    }
    if (this.libraryHandles.get(lib.name) !== handle) {
      throw new Error(
        `${lib.name}: dynamic-linker library index does not match handle ${handle}`,
      );
    }
    const references = this.handleRefCounts.get(handle);
    if (!Number.isInteger(references) || references! <= 0) {
      throw new Error(`${lib.name}: handle ${handle} has invalid refcount`);
    }
    if (references! > 1) {
      this.handleRefCounts.set(handle, references! - 1);
      this.lastError = null;
      return;
    }
    this.handleMap.delete(handle);
    this.libraryHandles.delete(lib.name);
    this.handleRefCounts.delete(handle);
    this.releaseUnretainedLibrary(lib);
    this.rebuildRuntimeIndexes();
    this.lastError = null;
  }

  /** Close a library handle. Returns 0 on success. */
  dlclose(handle: number): number {
    try {
      this.closeHandle(handle);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return -1;
    }
    return 0;
  }

  /** Replay one successful parent dlclose event exactly. */
  replayClose(exactHandle: number): void {
    requireNonzeroU32(exactHandle, "replay dlclose handle");
    this.closeHandle(exactHandle);
  }

  /** Get the last error message, or null if no error. */
  dlerror(): string | null {
    const err = this.lastError;
    this.lastError = null;
    return err;
  }
}
