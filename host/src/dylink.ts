/**
 * WebAssembly dynamic linking support — parses the dylink.0 custom section
 * and loads side modules into a running process's memory space.
 *
 * Follows the WebAssembly tool-conventions dynamic linking ABI:
 * https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md
 */

// dylink.0 sub-section types
const WASM_DYLINK_MEM_INFO = 1;
const WASM_DYLINK_NEEDED = 2;
const WASM_DYLINK_EXPORT_INFO = 3;
const WASM_DYLINK_IMPORT_INFO = 4;

// Export/import flags
const WASM_DYLINK_FLAG_TLS = 0x01;
const WASM_DYLINK_FLAG_WEAK = 0x02;

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
}

/**
 * Options used when re-instantiating a side module in a fork child.
 *
 * Preconditions:
 *   - Replay must run in the same order as the parent's original dlopens,
 *     against the same initial table/memory state. `__table_base` is
 *     captured from `options.table.length` at replay time and must equal
 *     the parent's value — anything that grows the child's table before
 *     replay (a future GOT-prealloc pass, an interleaved dlsym, etc.)
 *     diverges the layout and corrupts call_indirect targets.
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
  /** Global symbol table: name → function or WebAssembly.Global */
  globalSymbols: Map<string, Function | WebAssembly.Global>;
  /** GOT entries: symbol name → mutable i32 WebAssembly.Global */
  got: Map<string, WebAssembly.Global>;
  /** Already-loaded libraries for dedup and dependency resolution */
  loadedLibraries: Map<string, LoadedSharedLibrary>;
  /** Callback to locate and read a library file by name (async version) */
  resolveLibrary?: (name: string) => Promise<Uint8Array | null>;
  /** Callback to locate and read a library file by name (sync version) */
  resolveLibrarySync?: (name: string) => Uint8Array | null;
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
  // Allocate memory region
  const memAlign = 1 << metadata.memoryAlign;
  let memoryBase = 0;
  if (metadata.memorySize > 0) {
    if (replay) {
      // Reuse parent's memoryBase: data-reloc'd pointers baked into the
      // memcpy'd data section already encode (parentMemoryBase + offset).
      memoryBase = replay.memoryBase;
    } else if (options.allocateMemory) {
      memoryBase = options.allocateMemory(metadata.memorySize, memAlign);
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

  // Allocate table slots
  let tableBase = 0;
  if (metadata.tableSize > 0) {
    tableBase = options.table.length;
    options.table.grow(metadata.tableSize);
  }

  // Create immutable globals for memory_base and table_base
  const memoryBaseGlobal = new WebAssembly.Global(
    { value: "i32", mutable: false },
    memoryBase,
  );
  const tableBaseGlobal = new WebAssembly.Global(
    { value: "i32", mutable: false },
    tableBase,
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
    for (let i = 0; i < tbl.length; i++) {
      if (tbl.get(i) === fn) return i;
    }
    const idx = tbl.length;
    tbl.grow(1);
    tbl.set(idx, fn);
    return idx;
  };

  const getOrCreateGOTEntry = (
    symName: string,
    kind: "mem" | "func",
  ): WebAssembly.Global => {
    let entry = options.got.get(symName);
    if (!entry) {
      let initial = 0;
      const sym = options.globalSymbols.get(symName);
      if (kind === "mem" && sym instanceof WebAssembly.Global) {
        initial = sym.value as number;
      } else if (kind === "func" && typeof sym === "function") {
        initial = tableIndexFor(sym);
      }
      entry = new WebAssembly.Global({ value: "i32", mutable: true }, initial);
      options.got.set(symName, entry);
    }
    return entry;
  };

  // Tag imported by side modules compiled with clang's wasm SjLj lowering
  // (`-mllvm -wasm-enable-sjlj`). The host doesn't actually catch these — the
  // main process either has its own __c_longjmp tag (LLVM 22) or doesn't use
  // SjLj (LLVM 21). A stub Tag lets the side module's import type-check and
  // instantiate; behavior at throw time is undefined but the side module
  // typically never throws this tag itself.
  const longjmpTag = (typeof (WebAssembly as any).Tag === "function")
    ? new (WebAssembly as any).Tag({ parameters: ["i32"] })
    : undefined;

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
        }
        const sym = options.globalSymbols.get(prop);
        if (sym !== undefined) return sym;
        return undefined;
      },
      has(_target, prop: string) {
        if (["memory", "__indirect_function_table", "__memory_base",
             "__table_base", "__stack_pointer", "__c_longjmp"].includes(prop)) return true;
        return options.globalSymbols.has(prop);
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

  // Compile and instantiate synchronously
  const module = new WebAssembly.Module(wasmBytes as unknown as BufferSource);
  const instance = new WebAssembly.Instance(module, imports);

  // Relocate exports: data address globals need memoryBase added
  const relocatedExports: Record<string, WebAssembly.ExportValue> = {};
  for (const [exportName, exportValue] of Object.entries(instance.exports)) {
    if (exportValue instanceof WebAssembly.Global) {
      try {
        (exportValue as any).value = (exportValue as any).value;
        relocatedExports[exportName] = exportValue;
      } catch {
        relocatedExports[exportName] = new WebAssembly.Global(
          { value: "i32", mutable: false },
          (exportValue as WebAssembly.Global).value + memoryBase,
        );
      }
    } else {
      relocatedExports[exportName] = exportValue;
    }
  }

  // Update GOT with this library's exports
  for (const [exportName, exportValue] of Object.entries(relocatedExports)) {
    if (exportName.startsWith("__")) continue;

    if (typeof exportValue === "function") {
      const tableIdx = options.table.length;
      options.table.grow(1);
      options.table.set(tableIdx, exportValue as unknown as Function);

      const gotEntry = options.got.get(exportName);
      if (gotEntry) {
        gotEntry.value = tableIdx;
      }
      options.globalSymbols.set(exportName, exportValue as Function);
    } else if (exportValue instanceof WebAssembly.Global) {
      const addr = (exportValue as WebAssembly.Global).value;
      const gotEntry = options.got.get(exportName);
      if (gotEntry) {
        gotEntry.value = addr as number;
      }
      options.globalSymbols.set(exportName, exportValue);
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
  };

  options.loadedLibraries.set(name, loaded);
  return loaded;
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
        return global.value as number;
      }
    }

    if (typeof exp === "function") {
      // Return the table index for this function (C function pointers are table indices)
      const table = this.options.table;
      for (let i = 0; i < table.length; i++) {
        if (table.get(i) === exp) {
          this.lastError = null;
          return i;
        }
      }
      // Not in table yet — add it
      const idx = table.length;
      table.grow(1);
      table.set(idx, exp as unknown as Function);
      this.lastError = null;
      return idx;
    }

    if (exp instanceof WebAssembly.Global) {
      this.lastError = null;
      return (exp as WebAssembly.Global).value as number;
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
