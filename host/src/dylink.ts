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
 * Options for loading a shared library.
 */
export interface LoadSharedLibraryOptions {
  /** The shared Wasm.Memory used by the process */
  memory: WebAssembly.Memory;
  /** The process's indirect function table */
  table: WebAssembly.Table;
  /** Stack pointer global (shared across all modules) */
  stackPointer: WebAssembly.Global;
  /** Current heap pointer — updated after allocation */
  heapPointer: { value: number };
  /** Global symbol table: name → function or WebAssembly.Global */
  globalSymbols: Map<string, Function | WebAssembly.Global>;
  /** GOT entries: symbol name → mutable i32 WebAssembly.Global */
  got: Map<string, WebAssembly.Global>;
  /** Already-loaded libraries for dedup and dependency resolution */
  loadedLibraries: Map<string, LoadedSharedLibrary>;
  /** Callback to locate and read a library file by name */
  resolveLibrary?: (name: string) => Promise<Uint8Array | null>;
}

/**
 * Load a shared library (.so / side module) into a process's address space.
 *
 * This implements the WebAssembly dynamic linking ABI:
 * 1. Parse dylink.0 section for memory/table requirements
 * 2. Recursively load dependencies
 * 3. Allocate memory and table slots
 * 4. Construct imports with GOT proxy
 * 5. Instantiate the Wasm module
 * 6. Run relocations and constructors
 * 7. Register exports in the global symbol table
 */
export async function loadSharedLibrary(
  name: string,
  wasmBytes: Uint8Array,
  options: LoadSharedLibraryOptions,
): Promise<LoadedSharedLibrary> {
  // Check if already loaded
  const existing = options.loadedLibraries.get(name);
  if (existing) return existing;

  // Parse dylink.0 section
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

  // Allocate memory region
  const memAlign = 1 << metadata.memoryAlign;
  let memoryBase = 0;
  if (metadata.memorySize > 0) {
    memoryBase = alignUp(options.heapPointer.value, memAlign);
    options.heapPointer.value = memoryBase + metadata.memorySize;

    // Ensure the memory is large enough
    const neededPages = Math.ceil(options.heapPointer.value / 65536);
    const currentPages = options.memory.buffer.byteLength / 65536;
    if (neededPages > currentPages) {
      options.memory.grow(neededPages - currentPages);
    }

    // Zero-initialize the allocated region
    new Uint8Array(options.memory.buffer, memoryBase, metadata.memorySize).fill(0);
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

  // Build GOT proxy for imports
  const getOrCreateGOTEntry = (symName: string): WebAssembly.Global => {
    let entry = options.got.get(symName);
    if (!entry) {
      // Initialized to 0 (unresolved). Will be filled in by updateGOT.
      entry = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
      options.got.set(symName, entry);
    }
    return entry;
  };

  // Construct imports
  const imports: WebAssembly.Imports = {
    env: new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        switch (prop) {
          case "memory": return options.memory;
          case "__indirect_function_table": return options.table;
          case "__memory_base": return memoryBaseGlobal;
          case "__table_base": return tableBaseGlobal;
          case "__stack_pointer": return options.stackPointer;
        }
        // Check global symbol table
        const sym = options.globalSymbols.get(prop);
        if (sym !== undefined) return sym;
        // Return undefined — will be handled as unresolved
        return undefined;
      },
      has(_target, prop: string) {
        if (["memory", "__indirect_function_table", "__memory_base",
             "__table_base", "__stack_pointer"].includes(prop)) return true;
        return options.globalSymbols.has(prop);
      },
    }),
    "GOT.mem": new Proxy({} as Record<string, WebAssembly.Global>, {
      get(_target, prop: string) {
        return getOrCreateGOTEntry(prop);
      },
    }),
    "GOT.func": new Proxy({} as Record<string, WebAssembly.Global>, {
      get(_target, prop: string) {
        return getOrCreateGOTEntry(prop);
      },
    }),
  };

  // Compile and instantiate
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, imports);

  // Relocate exports: data address globals need memoryBase added
  const relocatedExports: Record<string, WebAssembly.ExportValue> = {};
  for (const [exportName, exportValue] of Object.entries(instance.exports)) {
    if (exportValue instanceof WebAssembly.Global) {
      // Check if it's an immutable global (data address)
      try {
        // Immutable globals throw on write
        (exportValue as any).value = (exportValue as any).value;
        // If we get here, it's mutable — don't relocate
        relocatedExports[exportName] = exportValue;
      } catch {
        // Immutable global — create a relocated copy
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
    if (exportName.startsWith("__")) continue; // Skip internal symbols

    if (typeof exportValue === "function") {
      // Function: add to table and store table index in GOT
      const tableIdx = options.table.length;
      options.table.grow(1);
      options.table.set(tableIdx, exportValue as WebAssembly.Function);

      const gotEntry = options.got.get(exportName);
      if (gotEntry) {
        gotEntry.value = tableIdx;
      }

      // Also add to global symbol table
      options.globalSymbols.set(exportName, exportValue as Function);
    } else if (exportValue instanceof WebAssembly.Global) {
      // Data address global
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

  // Run constructors
  const ctors = instance.exports.__wasm_call_ctors as Function | undefined;
  if (ctors) {
    ctors();
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
