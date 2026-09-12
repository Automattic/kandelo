/**
 * Place and instantiate the co-resident PIC fork-module. Shared by both JS
 * hosts; nothing here is Node- or browser-specific.
 *
 * This is the other half of the host floor, beside
 * `fork-module-host-capabilities.ts`. That file owns the two host FUNCTIONS a
 * host must implement; this one owns everything that is about PLACEMENT —
 * reserving a region in guest memory, deriving the position-independent-code
 * globals from the module's own `dylink.0` sizing, and creating the three
 * reference-typed tables the module imports.
 *
 * Placement cannot move into the module: a side module cannot choose where it
 * is placed, and `__memory_base` / `__table_base` are imports by construction.
 */

import {
  type ForkModuleHostImports,
} from "./fork-module-host-capabilities";

/**
 * Exports a host must find, or placement succeeded and nothing else will work.
 *
 * A FLOOR, not an inventory: the module exports far more, and a host binds
 * whichever it drives. These are the ones whose absence means the artifact is
 * not a fork-module at all — the errno channel, the format/catalog seeding a
 * host must do before any fork, and the module-owned GC transit table the
 * injector adds (`__wpk_fork_ref_gc_transit`, which is a Table, not a
 * function).
 */
export const FORK_MODULE_REQUIRED_EXPORTS = [
  "fm_last_errno",
  "fm_set_format",
  "fm_set_resume_catalog",
  "fm_stats",
  "__wpk_fork_ref_gc_transit",
] as const;

export type ForkModuleExports = Record<string, unknown>;

export interface ForkModuleInstance {
  readonly exports: ForkModuleExports;
  /** Byte offset in guest memory where the module's region was placed. */
  readonly memoryBase: number;
  /** Bytes reserved at `memoryBase`: static footprint plus the shadow stack. */
  readonly regionBytes: number;
  /** The module-owned `(ref null any)` transit table the injector exports. */
  readonly gcTransitTable: WebAssembly.Table;
  /** Host-supplied tables, exposed so a host can publish catalogs into them. */
  readonly functionCatalog: WebAssembly.Table;
  readonly driveTable: WebAssembly.Table;
  readonly staticRootCatalog: WebAssembly.Table;
}

export interface InstantiateForkModuleOptions {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly ptrWidth: 4 | 8;
  /** Reserve `size` bytes in guest memory and return the base offset. */
  readonly reserve: (size: number) => number;
  /** Included in every thrown message, so a failure names the process. */
  readonly label: string;
  /** The host functions. Omitted, each is a trapping stub. */
  readonly hostImports?: Partial<ForkModuleHostImports>;
  /** @deprecated The module owns its transit table; supplying one is a no-op. */
  readonly transitTable?: WebAssembly.Table;
}

/** The shadow stack reserved above the module's static footprint. */
const SHADOW_STACK_BYTES = 1024 * 1024;

/** `dylink.0` subsection id for the memory/table sizing record. */
const WASM_DYLINK_MEM_INFO = 1;

interface DylinkMemInfo {
  memorySize: number;
  memoryAlign: number;
  tableSize: number;
  tableAlign: number;
}

/**
 * Read `dylink.0` sizing via `WebAssembly.Module.customSections`.
 *
 * NOT via `parseDylinkSection` in `dylink-artifact.ts`. That reader requires
 * `dylink.0` to be the module's FIRST section, which the convention does say —
 * but this module's is the LAST of fourteen, so the reader returns null for it.
 * `customSections` finds a section by name wherever it sits, which is what lets
 * this work against the artifact as actually built. (The placement itself is
 * recorded in census §14; it is a link-step question, not this file's.)
 */
function readDylinkMemInfo(
  module: WebAssembly.Module,
  label: string,
): DylinkMemInfo {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (sections.length === 0) {
    throw new Error(
      `${label}: not a PIC side module — no dylink.0 custom section. A ` +
        `fork-module must be linked with --pie; a non-side module cannot be ` +
        `placed at a host-chosen __memory_base.`,
    );
  }
  const bytes = new Uint8Array(sections[0]);
  let offset = 0;
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      if (byte === undefined) {
        throw new Error(`${label}: truncated dylink.0 section`);
      }
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    const size = leb();
    const end = offset + size;
    if (kind === WASM_DYLINK_MEM_INFO) {
      return {
        memorySize: leb(),
        memoryAlign: leb(),
        tableSize: leb(),
        tableAlign: leb(),
      };
    }
    offset = end;
  }
  throw new Error(
    `${label}: dylink.0 carries no memory-info subsection, so the module's ` +
      `static footprint is unknown and it cannot be placed`,
  );
}

function alignUp(value: number, alignPow2: number): number {
  const alignment = 1 << alignPow2;
  return Math.ceil(value / alignment) * alignment;
}

function trap(label: string, name: string): never {
  throw new Error(
    `${label}: the fork-module called host import ${name}, which this host did ` +
      `not supply. A trapping stub is deliberate: a silent no-op would let a ` +
      `capture continue with a reference it never resolved.`,
  );
}

export function instantiateForkModule(
  options: InstantiateForkModuleOptions,
): ForkModuleInstance {
  const { module, memory, reserve, label, hostImports } = options;
  void options.transitTable; // deprecated; the module owns its transit table

  const info = readDylinkMemInfo(module, label);
  const regionBytes =
    alignUp(info.memorySize, info.memoryAlign) + SHADOW_STACK_BYTES;
  const memoryBase = reserve(regionBytes);

  if (memoryBase + regionBytes > memory.buffer.byteLength) {
    throw new Error(
      `${label}: fork-module region [${memoryBase}, ` +
        `${memoryBase + regionBytes}) does not fit in the provided memory of ` +
        `${memory.buffer.byteLength} bytes`,
    );
  }

  const functionCatalog = new WebAssembly.Table({
    element: "anyfunc",
    initial: 0,
  });
  const driveTable = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  // `anyref`, NOT `externref`: the static-root binder holds GC-hierarchy
  // values, and `any` and `extern` are disjoint roots, so the wrong element
  // type is rejected at instantiation.
  const staticRootCatalog = new WebAssembly.Table({
    element: "anyref",
    initial: 0,
  });

  const instance = new WebAssembly.Instance(module, {
    env: {
      memory,
      __indirect_function_table: new WebAssembly.Table({
        element: "anyfunc",
        initial: info.tableSize,
      }),
      // The shadow stack grows DOWN from the top of the reserved region.
      __stack_pointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        memoryBase + regionBytes,
      ),
      __memory_base: new WebAssembly.Global(
        { value: "i32", mutable: false },
        memoryBase,
      ),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      __wpk_fork_function_catalog: functionCatalog,
      __wpk_fork_drive_table: driveTable,
      __wpk_fork_static_root_catalog: staticRootCatalog,
      resolve_externref:
        hostImports?.resolve_externref ??
        (() => trap(label, "resolve_externref")),
      __wpk_fork_host_ref_identity:
        hostImports?.__wpk_fork_host_ref_identity ??
        (() => trap(label, "__wpk_fork_host_ref_identity")),
    },
  });

  const exports = instance.exports as ForkModuleExports;
  for (const name of FORK_MODULE_REQUIRED_EXPORTS) {
    if (exports[name] === undefined) {
      throw new Error(
        `${label}: fork-module is missing required export ${name}; the ` +
          `artifact placed successfully but is not a usable fork-module`,
      );
    }
  }

  return {
    exports,
    memoryBase,
    regionBytes,
    gcTransitTable: exports.__wpk_fork_ref_gc_transit as WebAssembly.Table,
    functionCatalog,
    driveTable,
    staticRootCatalog,
  };
}
