/**
 * WebAssembly dynamic linking support — parses the dylink.0 custom section
 * and loads side modules into a running process's memory space.
 *
 * Follows the WebAssembly tool-conventions dynamic linking ABI:
 * https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md
 */

import { ABI_VERSION } from "./generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "./process-memory";

// dylink.0 sub-section types
const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;
const WASM_DYLINK_EXPORT_INFO = 3;
const WASM_DYLINK_IMPORT_INFO = 4;

// Export/import flags
const WASM_DYLINK_FLAG_TLS = 0x01;
const WASM_DYLINK_FLAG_WEAK = 0x02;

export const SIDE_MODULE_FORK_EXPORTS = [
  "wpk_fork_unwind_begin",
  "wpk_fork_unwind_end",
  "wpk_fork_rewind_begin",
  "wpk_fork_rewind_end",
  "wpk_fork_state",
] as const;

export const FORK_CAPABILITIES_SECTION = "kandelo.wpk_fork.capabilities";
export const FORK_CAPABILITIES_VERSION = 1;
export const FORK_CAP_SIDE_ENTRY = 1 << 0;
export const FORK_CAP_DYLINK_MAIN = 1 << 1;
const FORK_CAP_KNOWN_MASK = FORK_CAP_SIDE_ENTRY | FORK_CAP_DYLINK_MAIN;
export const FORK_CAPABILITIES_REQUIRED_ABI = 17;

const WPK_FORK_NORMAL = 0;
const WPK_FORK_UNWINDING = 1;
const WPK_FORK_REWINDING = 2;

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

function tableLength(table: WebAssembly.Table): number {
  const raw = table.length as unknown as number | bigint;
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`invalid WebAssembly table length ${String(raw)}`);
  }
  return length;
}

function tableIndex(table: WebAssembly.Table, index: number): number {
  const rawLength = table.length as unknown as number | bigint;
  return (typeof rawLength === "bigint" ? BigInt(index) : index) as unknown as number;
}

function growTable(table: WebAssembly.Table, delta: number): void {
  table.grow(tableIndex(table, delta));
}

function getTableEntry(
  table: WebAssembly.Table,
  index: number,
): Function | null {
  return table.get(tableIndex(table, index));
}

function setTableEntry(
  table: WebAssembly.Table,
  index: number,
  value: Function | null,
): void {
  table.set(tableIndex(table, index), value);
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

/**
 * Shared library instance loaded into a process's address space.
 */
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
  /** Fork save buffer for an instrumented side module importing env.fork. */
  forkBufAddr?: number;
  /** Thread-local-storage base captured from the parent instance. */
  tlsBase?: number;
  /** Whether this module can originate a coordinated env.fork unwind. */
  forkCapable: boolean;
  /** Function/GOT.func imports used for conservative cross-side isolation. */
  functionImports: ReadonlySet<string>;
  /** Function exports visible to later side modules. */
  functionExports: ReadonlySet<string>;
  /** Dynamic lookup from a side module defeats static cross-side isolation. */
  importsDynamicLookup: boolean;
}

export interface SideModuleForkState {
  name: string;
  instance: WebAssembly.Instance;
  forkBufAddr: number;
  /** Byte capacity reserved for this module's continuation frames. */
  forkBufSize: number;
}

/**
 * Process-worker coordination for the one supported side-module fork shape:
 * a main-module call_indirect directly invokes one instrumented side module.
 * The loader rejects statically visible side-to-side linkage and side-owned
 * dlopen/dlsym around a fork-capable module. Opaque callbacks passed through
 * main memory or the shared table cannot yet be attributed to a module at
 * runtime and remain an explicit unsupported residual.
 */
export interface SideModuleForkSupport {
  setActiveFork: (state: SideModuleForkState) => void;
  clearActiveFork: (state: SideModuleForkState) => void;
  /** Invoke the immutable main-module fork trampoline and verify its state. */
  invokeMainFork: (expectedStateAfter: 0 | 1) => number;
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
 *     does not refresh existing entries; a duplicate would be silently
 *     deduped and return a handle whose memoryBase may not match.
 *   - The library must have no `dylink.0` NEEDED deps. Dep replay is not
 *     yet plumbed; `loadSharedLibrarySync` throws if you try.
 */
export interface DylinkReplayOptions {
  /** Memory base returned by the parent's allocator. Data relocations in
   *  the memcpy'd data section encode (memoryBase + offset); using any
   *  other base corrupts pointers. */
  memoryBase: number;
  /** Exact table base observed in the parent, including failed-load gaps. */
  tableBase: number;
  /** Exact side-module save buffer copied from the fork parent. */
  forkBufAddr?: number;
  /** Exact mutable `__tls_base` value from the fork parent. The child memory
   *  already contains the parent's live TLS bytes, so replay restores only
   *  this instance-local global and deliberately does not call
   *  `__wasm_init_tls`, which would reset those bytes to the initial image. */
  tlsBase?: number;
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
  /** Release a successful allocateMemory result when loading rolls back. */
  deallocateMemory?: (addr: number, size: number) => void;
  /** Global symbol table: name → function or WebAssembly.Global */
  globalSymbols: Map<string, Function | WebAssembly.Global>;
  /** GOT entries: symbol name → mutable pointer-width or table-index global */
  got: Map<string, WebAssembly.Global>;
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
  /** Process pointer width, which also determines the __c_longjmp payload. */
  ptrWidth?: 4 | 8;
  /** Immutable symbol names exported by the main module. */
  mainModuleSymbols?: ReadonlySet<string>;
  /** Present only in a process worker that can drive side-module unwind. */
  sideModuleFork?: SideModuleForkSupport;
  /** Precise rebuild/boundary diagnostic when sideModuleFork is unavailable. */
  sideModuleForkUnavailableReason?: string;
  /** Callback to locate and read a library file by name (async version) */
  resolveLibrary?: (name: string) => Promise<Uint8Array | null>;
  /** Callback to locate and read a library file by name (sync version) */
  resolveLibrarySync?: (name: string) => Uint8Array | null;
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

const SIDE_DYNAMIC_LOOKUP_IMPORTS = new Set([
  "__wasm_dlopen",
  "__wasm_dlsym",
  "dlopen",
  "dlsym",
]);

function intersectSideSymbols(
  imports: ReadonlySet<string>,
  exports: ReadonlySet<string>,
  mainSymbols: ReadonlySet<string>,
): string[] {
  return Array.from(imports)
    .filter((name) => !mainSymbols.has(name) && exports.has(name))
    .sort();
}

/**
 * The current two-module unwind protocol supports main -> one side module.
 * It cannot serialize an intervening side-module frame. Preserve ordinary
 * independent multi-extension loading, but reject statically visible
 * side-to-side linkage and side-originated dynamic lookup whenever either
 * participant can fork. Function pointers passed opaquely through main memory
 * remain a documented residual until the runtime has module activation hooks.
 */
function enforceDirectMainSideForkBoundary(
  name: string,
  forkCapable: boolean,
  functionImports: ReadonlySet<string>,
  functionExports: ReadonlySet<string>,
  importsDynamicLookup: boolean,
  options: LoadSharedLibraryOptions,
): void {
  const mainSymbols = options.mainModuleSymbols ?? new Set<string>();
  for (const loaded of options.loadedLibraries.values()) {
    if (!forkCapable && !loaded.forkCapable) continue;

    if (importsDynamicLookup || loaded.importsDynamicLookup) {
      throw new Error(
        `${name}: fork-capable side modules cannot coexist with side-originated ` +
          `dlopen/dlsym; only a direct main-module-to-side fork path is supported`,
      );
    }

    const newToLoaded = intersectSideSymbols(
      functionImports,
      loaded.functionExports,
      mainSymbols,
    );
    const loadedToNew = intersectSideSymbols(
      loaded.functionImports,
      functionExports,
      mainSymbols,
    );
    const crossSymbols = [...newToLoaded, ...loadedToNew];
    if (crossSymbols.length > 0) {
      throw new Error(
        `${name}: fork-capable side-module nesting through ${loaded.name} is unsupported ` +
          `(cross-side symbols: ${Array.from(new Set(crossSymbols)).join(", ")})`,
      );
    }
  }
}

/**
 * Core shared library loading logic — instantiates a pre-parsed Wasm
 * side module into the process address space. Used by both async and sync
 * entry points.
 */
function instantiateSharedLibrary(
  name: string,
  wasmBytes: Uint8Array,
  metadata: DylinkMetadata,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
): LoadedSharedLibrary {
  const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
  const moduleImports = WebAssembly.Module.imports(module);
  const moduleExports = WebAssembly.Module.exports(module);
  const importsFork = moduleImports.some((imp) =>
    imp.module === "env" && imp.name === "fork" && imp.kind === "function"
  );
  const presentForkExports = SIDE_MODULE_FORK_EXPORTS.filter((exportName) =>
    moduleExports.some((exp) => exp.kind === "function" && exp.name === exportName)
  );
  const hasCompleteForkInstrumentation =
    presentForkExports.length === SIDE_MODULE_FORK_EXPORTS.length;
  const forkCapabilityClaim = readForkInstrumentCapabilityClaim(module);
  const claimsSideEntry =
    forkCapabilityClaim.present
    && (forkCapabilityClaim.flags & FORK_CAP_SIDE_ENTRY) !== 0;
  const sideEntryAvailable = forkInstrumentRoleAvailable(
    forkCapabilityClaim,
    FORK_CAP_SIDE_ENTRY,
  );
  const functionImports = new Set(
    moduleImports
      .filter((imp) =>
        (imp.module === "env" && imp.kind === "function")
        || imp.module === "GOT.func"
      )
      .map((imp) => imp.name),
  );
  const functionExports = new Set(
    moduleExports.filter((exp) => exp.kind === "function").map((exp) => exp.name),
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
  const importsDynamicLookup = moduleImports.some((imp) =>
    imp.module === "env"
      && imp.kind === "function"
      && SIDE_DYNAMIC_LOOKUP_IMPORTS.has(imp.name)
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

  if (presentForkExports.length > 0 && !hasCompleteForkInstrumentation) {
    const missing = SIDE_MODULE_FORK_EXPORTS.filter((exportName) =>
      !moduleExports.some((exp) => exp.kind === "function" && exp.name === exportName)
    );
    throw new Error(
      `${name}: incomplete wasm-fork-instrument exports; missing ${missing.join(", ")}`,
    );
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
  if (claimsSideEntry && !importsFork) {
    throw new Error(`${name}: side-entry capability is present without an env.fork import`);
  }
  if (importsFork && !options.sideModuleFork) {
    throw new Error(
      `${name}: env.fork cannot be coordinated: ` +
        (options.sideModuleForkUnavailableReason
          ?? "side-module fork requires a process-worker unwind coordinator"),
    );
  }
  enforceDirectMainSideForkBoundary(
    name,
    importsFork,
    functionImports,
    functionExports,
    importsDynamicLookup,
    options,
  );

  const ptrWidth = options.ptrWidth ?? 4;
  // Memory and table address types are independent Wasm features. Reflect the
  // actual shared objects instead of assuming both widths from the C ABI.
  const memory64 = typeof options.stackPointer.value === "bigint";
  const table64 = typeof (
    options.table.length as unknown as number | bigint
  ) === "bigint";
  const tableRollbackBase = tableLength(options.table);
  const heapRollbackValue = options.heapPointer?.value;
  const symbolRollback = new Map(options.globalSymbols);
  const gotRollback = new Map(
    Array.from(options.got, ([symbol, global]) => [
      symbol,
      { global, value: global.value },
    ] as const),
  );
  const allocations: Array<{ addr: number; size: number }> = [];
  const allocate = (size: number, align: number): number => {
    if (!options.allocateMemory) {
      throw new Error(`${name}: no side-module memory allocator configured`);
    }
    const addr = options.allocateMemory(size, align);
    allocations.push({ addr, size });
    return addr;
  };

  try {
    // Allocate memory region
    const memAlign = 1 << metadata.memoryAlign;
    let memoryBase = 0;
    if (metadata.memorySize > 0) {
      if (replay) {
        // Reuse parent's memoryBase: data-reloc'd pointers baked into the
        // memcpy'd data section already encode (parentMemoryBase + offset).
        memoryBase = replay.memoryBase;
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
          options.memory.grow(neededPages - currentPages);
        }
      }

      if (!replay) {
        // Skip zero-init in replay: child memory already holds parent's
        // post-startup data via fork memcpy.
        new Uint8Array(options.memory.buffer, memoryBase, metadata.memorySize).fill(0);
      }
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
    if (metadata.tableSize > 0) growTable(options.table, metadata.tableSize);

    let sideForkBufAddr = 0;
    if (importsFork) {
      if (replay) {
        sideForkBufAddr = replay.forkBufAddr ?? 0;
      } else if (options.allocateMemory) {
        sideForkBufAddr = allocate(FORK_SAVE_BUFFER_SIZE, 16);
      } else if (options.heapPointer) {
        sideForkBufAddr = alignUp(options.heapPointer.value, 16);
        options.heapPointer.value = sideForkBufAddr + FORK_SAVE_BUFFER_SIZE;
        const neededPages = Math.ceil(options.heapPointer.value / 65536);
        const currentPages = options.memory.buffer.byteLength / 65536;
        if (neededPages > currentPages) options.memory.grow(neededPages - currentPages);
      }
      if (
        sideForkBufAddr <= 0
        || sideForkBufAddr + FORK_SAVE_BUFFER_SIZE > options.memory.buffer.byteLength
      ) {
        throw new Error(`${name}: invalid side-module fork save buffer`);
      }
    }

    // Memory64 side modules import memory addresses and table indices as i64.
    const memoryBaseGlobal = new WebAssembly.Global(
      { value: memory64 ? "i64" : "i32", mutable: false },
      memory64 ? BigInt(memoryBase) : memoryBase,
    );
    const tableBaseGlobal = new WebAssembly.Global(
      { value: table64 ? "i64" : "i32", mutable: false },
      table64 ? BigInt(tableBase) : tableBase,
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
      const tbl = options.table;
      const length = tableLength(tbl);
      for (let i = 0; i < length; i++) {
        if (getTableEntry(tbl, i) === fn) return i;
      }
      const idx = length;
      growTable(tbl, 1);
      setTableEntry(tbl, idx, fn);
      return idx;
    };

    const getOrCreateGOTEntry = (
      symName: string,
      kind: "mem" | "func",
    ): WebAssembly.Global => {
      let entry = options.got.get(symName);
      if (!entry) {
        const widePointer = kind === "mem" ? memory64 : table64;
        let initial: number | bigint = widePointer ? 0n : 0;
        const sym = options.globalSymbols.get(symName);
        if (kind === "mem" && sym instanceof WebAssembly.Global) {
          initial = widePointer ? BigInt(sym.value) : Number(sym.value);
        } else if (kind === "func" && typeof sym === "function") {
          const index = tableIndexFor(sym);
          initial = widePointer ? BigInt(index) : index;
        }
        entry = new WebAssembly.Global(
          { value: widePointer ? "i64" : "i32", mutable: true },
          initial,
        );
        options.got.set(symName, entry);
      }
      return entry;
    };

    let instance: WebAssembly.Instance | null = null;
    let sideForkState: SideModuleForkState | null = null;
    const forkState = (): number => {
      if (!instance) throw new Error(`${name}: side-module fork before instantiation`);
      return Number((instance.exports.wpk_fork_state as () => number)());
    };

    const sideModuleForkImport = (): number => {
      if (!instance || !options.sideModuleFork || sideForkBufAddr === 0) {
        throw new Error(`${name}: side-module fork coordinator is unavailable`);
      }
      const state = forkState();
      if (state === WPK_FORK_NORMAL) {
        (instance.exports.wpk_fork_unwind_begin as (addr: number) => void)(sideForkBufAddr);
        if (forkState() !== WPK_FORK_UNWINDING) {
          throw new Error(`${name}: side-module fork failed to enter UNWINDING`);
        }
        sideForkState = {
          name,
          instance,
          forkBufAddr: sideForkBufAddr,
          forkBufSize: FORK_SAVE_BUFFER_SIZE,
        };
        options.sideModuleFork.setActiveFork(sideForkState);
        return options.sideModuleFork.invokeMainFork(WPK_FORK_UNWINDING);
      }

      if (state === WPK_FORK_REWINDING) {
        (instance.exports.wpk_fork_rewind_end as () => void)();
        if (forkState() !== WPK_FORK_NORMAL) {
          throw new Error(`${name}: side-module fork failed to finish REWINDING`);
        }
        // A fork child re-instantiates this module, so its closure cannot retain
        // the parent's SideModuleForkState object. The worker reconstructs the
        // active identity from the copied archive/buffer metadata; rebuild the
        // same structural identity here before clearing it.
        const completedState = sideForkState ?? {
          name,
          instance,
          forkBufAddr: sideForkBufAddr,
          forkBufSize: FORK_SAVE_BUFFER_SIZE,
        };
        const result = options.sideModuleFork.invokeMainFork(WPK_FORK_NORMAL);
        options.sideModuleFork.clearActiveFork(completedState);
        sideForkState = null;
        return result;
      }

      throw new Error(`${name}: env.fork reached in unexpected state ${state}`);
    };

    // Construct imports
    const imports: WebAssembly.Imports = {
      env: new Proxy({} as Record<string, WebAssembly.ImportValue>, {
        get(_target, prop: string) {
          switch (prop) {
            case "memory": return options.memory;
            case "__indirect_function_table": return options.table;
            case "__memory_base": return memoryBaseGlobal;
            case "__table_base": return tableBaseGlobal;
            case "__stack_pointer": return options.stackPointer;
            case "__c_longjmp": return longjmpTag;
            case "__cpp_exception": return cppExceptionTag;
            case "fork":
              if (importsFork) return sideModuleForkImport;
              break;
          }
          const sym = options.globalSymbols.get(prop);
          if (sym !== undefined) return sym;
          if (selfFunctionImports.has(prop)) {
            return (...args: unknown[]) => {
              const fn = instance?.exports[prop];
              if (typeof fn !== "function") {
                throw new Error(`${name}: self import env.${prop} is unavailable`);
              }
              return (fn as Function)(...args);
            };
          }
          return undefined;
        },
        has(_target, prop: string) {
          if (["memory", "__indirect_function_table", "__memory_base",
               "__table_base", "__stack_pointer", "__c_longjmp",
               "__cpp_exception"].includes(prop)) return true;
          if (prop === "fork" && importsFork) return true;
          return options.globalSymbols.has(prop) || selfFunctionImports.has(prop);
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

    // Instantiate synchronously after validating the side-module fork contract.
    instance = new WebAssembly.Instance(module, imports);

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
        if (!Number.isSafeInteger(replay.tlsBase) || replay.tlsBase! <= 0) {
          throw new Error(`${name}: fork replay is missing a valid side-module TLS base`);
        }
        try {
          tlsBaseExport.value = typeof initialRawTlsBase === "bigint"
            ? BigInt(replay.tlsBase!)
            : replay.tlsBase!;
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

    // Update GOT with this library's exports
    for (const [exportName, exportValue] of Object.entries(relocatedExports)) {
      if (exportName.startsWith("__")) continue;
      const alreadyDefined = options.globalSymbols.has(exportName);

      if (typeof exportValue === "function") {
        const tableIdx = tableLength(options.table);
        growTable(options.table, 1);
        setTableEntry(options.table, tableIdx, exportValue as unknown as Function);

        const gotEntry = options.got.get(exportName);
        if (gotEntry && !alreadyDefined) {
          gotEntry.value = table64 ? BigInt(tableIdx) : tableIdx;
        }
        if (!alreadyDefined) {
          options.globalSymbols.set(exportName, exportValue as Function);
        }
      } else if (exportValue instanceof WebAssembly.Global) {
        const addr = (exportValue as WebAssembly.Global).value;
        const gotEntry = options.got.get(exportName);
        if (gotEntry && !alreadyDefined) {
          gotEntry.value = addr as number;
        }
        if (!alreadyDefined) {
          options.globalSymbols.set(exportName, exportValue);
        }
      }
    }

    // Run data relocations
    const applyRelocs = instance.exports.__wasm_apply_data_relocs as Function | undefined;
    if (applyRelocs) {
      applyRelocs();
    }

    if (!replay) {
      // Skip ctors in replay: parent already ran them and post-startup state
      // (e.g. opcache accel_globals, registered INI entries) is in the
      // memcpy'd data; re-running would clobber it.
      const ctors = instance.exports.__wasm_call_ctors as Function | undefined;
      if (ctors) {
        ctors();
      }
    }

    const loaded: LoadedSharedLibrary = {
      instance,
      memoryBase,
      tableBase,
      exports: relocatedExports,
      metadata,
      name,
      forkBufAddr: sideForkBufAddr || undefined,
      tlsBase,
      forkCapable: importsFork,
      functionImports,
      functionExports,
      importsDynamicLookup,
    };

    options.loadedLibraries.set(name, loaded);
    return loaded;
  } catch (error) {
    // Restore every mutable host-side linker structure we can. Table length and
    // Wasm memory cannot shrink, so clear newly-addressable table slots and let
    // the next successful archive entry record the resulting exact table base.
    const rollbackEnd = tableLength(options.table);
    for (let i = tableRollbackBase; i < rollbackEnd; i++) {
      try { setTableEntry(options.table, i, null); } catch { /* best effort */ }
    }
    options.globalSymbols.clear();
    for (const [symbol, value] of symbolRollback) options.globalSymbols.set(symbol, value);
    options.got.clear();
    for (const [symbol, snapshot] of gotRollback) {
      try { snapshot.global.value = snapshot.value; } catch { /* immutable should not occur */ }
      options.got.set(symbol, snapshot.global);
    }
    if (options.heapPointer && heapRollbackValue !== undefined) {
      options.heapPointer.value = heapRollbackValue;
    }
    if (options.deallocateMemory) {
      for (const allocation of allocations.reverse()) {
        try { options.deallocateMemory(allocation.addr, allocation.size); } catch { /* preserve cause */ }
      }
    }
    throw error;
  }
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
): Promise<LoadedSharedLibrary> {
  validateLongjmpConfiguration(options);
  const existing = options.loadedLibraries.get(name);
  if (existing) return existing;

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
    const depBytes = await options.resolveLibrary(dep);
    if (!depBytes) {
      throw new Error(`${name}: dependency ${dep} not found`);
    }
    await loadSharedLibrary(dep, depBytes, options);
  }

  return instantiateSharedLibrary(name, wasmBytes, metadata, options);
}

/**
 * Load a shared library synchronously. Required for dlopen() which must
 * return synchronously to C code. Uses synchronous WebAssembly compilation.
 */
export function loadSharedLibrarySync(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
  replay?: DylinkReplayOptions,
): LoadedSharedLibrary {
  validateLongjmpConfiguration(options);
  const existing = options.loadedLibraries.get(name);
  if (existing) return existing;

  const metadata = parseDylinkSection(wasmBytes);
  if (!metadata) {
    throw new Error(`${name}: not a shared library (no dylink.0 section)`);
  }

  // Replay-with-deps would re-allocate the dep at the child's *current*
  // mmap cursor (not the parent's address) and corrupt the replayed
  // library's data-relocs, which encode the parent's dep memoryBase.
  // Fail loudly instead of silently producing wrong addresses.
  if (replay && metadata.neededDynlibs.length > 0) {
    throw new Error(
      `${name}: replay does not yet support NEEDED deps; ` +
        `each dep would need its own DylinkReplayOptions in a future API extension`,
    );
  }

  // Load dependencies first (sync). Replay is not forwarded: dep replay is
  // out-of-scope (guarded above); the recursive call instantiates deps freshly.
  for (const dep of metadata.neededDynlibs) {
    if (options.loadedLibraries.has(dep)) continue;
    if (!options.resolveLibrarySync) {
      throw new Error(`${name}: depends on ${dep} but no resolveLibrarySync callback provided`);
    }
    const depBytes = options.resolveLibrarySync(dep);
    if (!depBytes) {
      throw new Error(`${name}: dependency ${dep} not found`);
    }
    loadSharedLibrarySync(dep, depBytes, options);
  }

  return instantiateSharedLibrary(name, wasmBytes, metadata, options, replay);
}

/**
 * Manages dynamic linking state for a single process. Provides the dlopen/dlsym/
 * dlclose API that maps to C runtime calls.
 */
export class DynamicLinker {
  private options: LoadSharedLibraryOptions;
  private handleCounter = 1;
  private handleMap = new Map<number, LoadedSharedLibrary>();
  private lastError: string | null = null;

  constructor(options: LoadSharedLibraryOptions) {
    validateLongjmpConfiguration(options);
    this.options = options;
  }

  /** Open a shared library. Returns a handle (>0) or 0 on error.
   *  When `replay` is provided, behaves as fork-replay: uses the parent's
   *  saved memoryBase and skips __wasm_call_ctors. See `DylinkReplayOptions`
   *  for preconditions. */
  dlopenSync(name: string, wasmBytes: Uint8Array, replay?: DylinkReplayOptions): number {
    try {
      const lib = loadSharedLibrarySync(name, wasmBytes, this.options, replay);
      // Check if already mapped to a handle
      for (const [h, l] of this.handleMap) {
        if (l === lib) return h;
      }
      const handle = this.handleCounter++;
      this.handleMap.set(handle, lib);
      this.lastError = null;
      return handle;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return 0;
    }
  }

  /** Look up a symbol by name. Returns the function or address, or null. */
  dlsym(handle: number, symbolName: string): Function | number | null {
    const lib = this.handleMap.get(handle);
    if (!lib) {
      this.lastError = "invalid handle";
      return null;
    }

    const exp = lib.exports[symbolName];
    if (exp === undefined) {
      // Also check global symbol table (symbol may come from a dependency)
      const global = this.options.globalSymbols.get(symbolName);
      if (global === undefined) {
        this.lastError = `symbol not found: ${symbolName}`;
        return null;
      }
      if (typeof global === "function") {
        this.lastError = null;
        return global;
      }
      if (global instanceof WebAssembly.Global) {
        this.lastError = null;
        return Number(global.value);
      }
    }

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
      this.lastError = null;
      return idx;
    }

    if (exp instanceof WebAssembly.Global) {
      this.lastError = null;
      return Number((exp as WebAssembly.Global).value);
    }

    this.lastError = `symbol not found: ${symbolName}`;
    return null;
  }

  /** Close a library handle. Returns 0 on success. */
  dlclose(handle: number): number {
    if (!this.handleMap.has(handle)) {
      this.lastError = "invalid handle";
      return -1;
    }
    this.handleMap.delete(handle);
    this.lastError = null;
    return 0;
  }

  /** Get the last error message, or null if no error. */
  dlerror(): string | null {
    const err = this.lastError;
    this.lastError = null;
    return err;
  }
}
