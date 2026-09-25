/**
 * Place and instantiate the co-resident PIC fork-module. Shared by both JS
 * hosts; nothing here is Node- or browser-specific.
 *
 * This is the other half of the host floor, beside
 * `fork-module-host-capabilities.ts`. That file owns the two host FUNCTIONS a
 * host must implement (the reference and function identity oracles); this one owns everything that is about PLACEMENT —
 * reserving a region in guest memory, deriving the position-independent-code
 * globals from the module's own `dylink.0` sizing, and creating the three
 * reference-typed tables the module imports.
 *
 * Placement cannot move into the module: a side module cannot choose where it
 * is placed, and `__memory_base` / `__table_base` are imports by construction.
 */

import {
  createForkModuleHostCapabilities,
  type ForkModuleHostImports,
} from "./fork-module-host-capabilities";

/**
 * Exports a host must find, or placement succeeded and nothing else will work.
 *
 * A FLOOR, not an inventory: the module exports far more, and a host binds
 * whichever it drives. These are the ones whose absence means the artifact is
 * not a fork-module at all — the errno channel, the format seed and the
 * activation admission a host must make before any fork, and the module-owned GC transit table the
 * injector adds (`__wpk_fork_ref_gc_transit`, which is a Table, not a
 * function).
 */
export const FORK_MODULE_REQUIRED_EXPORTS = [
  "fm_last_errno",
  "fm_set_format",
  "fm_admit_activation",
  "fm_stats",
  "__wpk_fork_ref_gc_transit",
] as const;

export type ForkModuleExports = Record<string, unknown>;

export interface ForkModuleInstance {
  readonly exports: ForkModuleExports;
  /** Byte offset in guest memory where the module's region was placed. */
  readonly memoryBase: number;
  /**
   * Bytes reserved at `memoryBase`: static footprint, shadow stack, and
   * staging slab.
   */
  readonly regionBytes: number;
  /** Host-supplied tables, exposed so a host can publish catalogs into them. */
  readonly functionCatalog: WebAssembly.Table;
  readonly driveTable: WebAssembly.Table;
  readonly staticRootCatalog: WebAssembly.Table;
  /**
   * A fixed staging slab INSIDE the reserved region, the per-call scratch
   * every host-to-module stage lands in.
   *
   * It lives here so the common stage costs no syscall and never grows the
   * process memory, which a copied fork child clones. An admission larger
   * than the slab is staged in a buffer the module maps and releases around
   * that admission instead; linear memory cannot shrink, so the first such mapping
   * may grow the memory once, and later ones reuse the freed range.
   */
  readonly stagingBase: number;
  readonly stagingBytes: number;
}

export interface InstantiateForkModuleOptions {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  /** Reserve `size` bytes in guest memory and return the base offset. */
  readonly reserve: (size: number) => number;
  /** Included in every thrown message, so a failure names the process. */
  readonly label: string;
  /**
   * Explicit host functions, overriding the derived ones. The identity
   * oracles need no input, so every instance binds both; a test overrides one
   * to observe or fail it.
   */
  readonly hostImports?: Partial<ForkModuleHostImports>;
}

/** The shadow stack reserved above the module's static footprint. */
const SHADOW_STACK_BYTES = 1024 * 1024;

/**
 * The staging slab reserved above the shadow stack: ONE wasm page, reserved by
 * every fork-capable process and thread worker for its whole life.
 *
 * The slab is a per-call scratch (`ForkModuleContinuationBackend.stage()`):
 * the module copies everything staged during the entry that takes it, so it
 * holds one request at a time. Its largest request is an activation's whole
 * admission (`fm_admit_activation`). One page is sized for the COMMON case,
 * not the largest: measured on 2026-09-25 over the 62 fork-instrumented
 * artifacts under `local-binaries/programs/wasm32`, every admission fits
 * (largest wget.wasm at 54,880 bytes). php does not: php.wasm stages 152,480
 * bytes, php-fpm.wasm 153,792 and its `intl.so` extension 252,753. Those go to a
 * buffer the fork module maps to their size (`fm_admission_buffer`) and
 * releases when the admission returns.
 *
 * It was four pages from lane F stage 1b, sized so the largest admission fit,
 * which charged every thread of every forking program 256 KiB for php's
 * extensions. The side-activation list (`stageSides`, 8 bytes per activation)
 * always stages here; a request too large for the slab is refused loudly
 * ("staging slab exhausted"). Written as a product of two integer literals,
 * which the storage ledger's recorder parses.
 */
const STAGING_SLAB_BYTES = 64 * 1024;

const WASM_PAGE_BYTES = 65536;

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

export function instantiateForkModule(
  options: InstantiateForkModuleOptions,
): ForkModuleInstance {
  const { module, memory, reserve, label, hostImports } = options;

  const info = readDylinkMemInfo(module, label);
  // Layout, low to high: the module's static/BSS footprint, then the shadow
  // stack, then the staging slab. `__stack_pointer` starts at the TOP of the
  // shadow stack and grows DOWN into it, bounded below by the static footprint
  // -- so it can never reach the staging slab above it, and never leaves the
  // region at all.
  const staticBytes = alignUp(info.memorySize, info.memoryAlign);
  const stackTopOffset = staticBytes + SHADOW_STACK_BYTES;
  const stagingOffset =
    Math.ceil(stackTopOffset / WASM_PAGE_BYTES) * WASM_PAGE_BYTES;
  const regionBytes = stagingOffset + STAGING_SLAB_BYTES;
  const memoryBase = reserve(regionBytes);

  if (memoryBase + regionBytes > memory.buffer.byteLength) {
    throw new Error(
      `${label}: fork-module region [${memoryBase}, ` +
        `${memoryBase + regionBytes}) does not fit in the provided memory of ` +
        `${memory.buffer.byteLength} bytes`,
    );
  }

  // `anyref`, NOT `externref`, for the static-root catalog: the binder holds
  // GC-hierarchy values, and `any` and `extern` are disjoint roots, so the
  // wrong element type is rejected at instantiation.
  const emptyTable = (element: "anyfunc" | "anyref"): WebAssembly.Table =>
    // The cast is at a TYPING boundary, not a capability one: every engine
    // Kandelo runs on accepts an `anyref` table, but lib.dom still declares
    // `TableKind` as `"anyfunc" | "externref"` -- it predates the GC proposal.
    // Widening it here rather than in a global augmentation keeps the stale
    // declaration visible at the one place that has to work around it.
    new WebAssembly.Table({ element: element as "anyfunc", initial: 0 });
  const functionCatalog = emptyTable("anyfunc");
  const driveTable = emptyTable("anyfunc");
  const staticRootCatalog = emptyTable("anyref");

  const capabilities = createForkModuleHostCapabilities();
  const resolved: ForkModuleHostImports = {
    ...capabilities.imports,
    ...(hostImports ?? {}),
  };

  const env: WebAssembly.ModuleImports = {
      memory,
      __indirect_function_table: new WebAssembly.Table({
        element: "anyfunc",
        initial: info.tableSize,
      }),
      // The shadow stack grows DOWN from the top of the reserved region.
      __stack_pointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        memoryBase + stackTopOffset,
      ),
      __memory_base: new WebAssembly.Global(
        { value: "i32", mutable: false },
        memoryBase,
      ),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      __wpk_fork_function_catalog: functionCatalog,
      __wpk_fork_drive_table: driveTable,
      __wpk_fork_static_root_catalog: staticRootCatalog,
      ...resolved,
  };
  // BEFORE instantiating, because after it a missing binding has already
  // surfaced as a `LinkError` naming an import INDEX. The guest side of this
  // contract is complete by construction (`buildForkGuestImports`); this side
  // was not, which is how an import added to the module reached this file's own
  // tests as an unreadable link failure.
  const unbound = WebAssembly.Module.imports(module)
    .filter((i) => i.module === "env" && i.kind === "function")
    .map((i) => i.name)
    .filter((name) => !(name in (env as Record<string, unknown>)));
  if (unbound.length > 0) {
    throw new Error(
      `${label}: the fork-module imports ${unbound.length} host function(s) ` +
        `this host does not bind: ${unbound.join(", ")}`,
    );
  }
  const instance = new WebAssembly.Instance(module, { env });

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
    functionCatalog,
    driveTable,
    staticRootCatalog,
    stagingBase: memoryBase + stagingOffset,
    stagingBytes: STAGING_SLAB_BYTES,
  };
}
