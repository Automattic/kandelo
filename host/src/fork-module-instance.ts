// Instantiate the co-resident `fork-module` PIC side module into a
// host-reserved region of the guest's shared linear memory.
//
// Phase 6 D5: the `fork-module` (crates/fork-module) is built as a
// POSITION-INDEPENDENT (`--pie`) wasm SIDE MODULE. It imports the guest's
// single shared `env.memory` plus the placement globals `env.__memory_base`
// (immutable), `env.__stack_pointer` (mutable), `env.__table_base`
// (immutable), and `env.__indirect_function_table`. Its data segments are
// PASSIVE and copied to `__memory_base + offset` by its start function
// (`__wasm_apply_data_relocs`) during instantiation.
//
// Placing the module's static data / BSS heap / shadow stack at a
// host-chosen region — instead of the fixed low offsets a plain cdylib would
// use — is the gating fix: those offsets would otherwise COLLIDE with and
// corrupt live guest data. This mirrors the placement contract `dylink.ts`
// already uses for shared libraries: reserve a region, then hand the module
// `__memory_base` / `__table_base` / `__stack_pointer` pointing into it.
//
// This module ONLY instantiates and asserts the module. It does NOT flip any
// guest fork import: the guest still uses the JavaScript `continuationImports`
// closures. Wiring the import flip is a later D5 step.

/** Exports the guest-facing continuation ABI plus the module lifecycle hooks. */
export const FORK_MODULE_REQUIRED_EXPORTS = [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  // Phase 6 D7a.1a: the activation-parameterized SHARED frame exports the
  // per-activation trampolines (`fork-module-trampoline.ts`) delegate to. A
  // dlopen fork has N activations; the frozen guest-facing `__wpk_fork_frame_*`
  // above are these with `act == primary_activation` (the single-activation
  // degenerate case). Each activation's frames route to its OWN writer/driver in
  // the module map while the journal + resume table stay process-wide.
  "fm_frame_reserve",
  "fm_frame_commit",
  "fm_frame_peek",
  "fm_frame_next",
  "fm_resume_peek",
  "fm_set_format",
  "fm_set_resume_catalog",
  // Phase 6 D7a.1a: seed ONE activation's resume catalog (a dlopen fork loads N
  // modules, each with its own catalog table) so each activation's resume-slot
  // numbering matches ITS JS `__wpk_fork_resume_table` by construction.
  "fm_set_activation_resume_catalog",
  // Phase 6 D7a.1b: seed ONE activation's function-catalog BASE into the merged,
  // activation-namespaced funcref catalog so `fm_funcref_ordinal` returns the
  // global slot `base(module_activation) + function_ordinal`. This is what makes
  // a dlopen fork's multi-activation funcref references reconstruct through the
  // module (a funcref minted in one activation but held by another's frame
  // resolves against its own activation's catalog slice).
  "fm_set_activation_catalog_base",
  "fm_begin_unwind",
  // Phase 6 D7a.1a: add ANOTHER activation (a dlopen fork's side module) to the
  // capture begun by `fm_begin_unwind`, with its own host frame arena + prefix.
  "fm_add_activation_unwind",
  "fm_finish_unwind",
  // Option B (minimize host surface): serialize the sealed journal into a chunk
  // the module channel-mmaps itself, returning its guest offset; the host reads
  // `fm_journal_image_len` and records both in a `JournalImage` KFMS record.
  "fm_serialize_journal_alloc",
  "fm_journal_image_len",
  // Release every channel-mapped frame/image chunk on the host abort path.
  "fm_abort",
  "fm_begin_replay",
  "fm_begin_child_replay",
  // Phase 6 D7a.1a: add a dlopen fork's SIDE activation to the child replay
  // begun by `fm_begin_child_replay`, at its inherited continuation anchor.
  "fm_add_activation_child_replay",
  "fm_finish_replay",
  "fm_frames_committed",
  // Phase 6 D7b: replay-side proof-of-use counter. A replay-only forked child
  // never commits a frame, so this (not `fm_frames_committed`) is what proves a
  // fork-from-thread child drove its rewind through the module.
  "fm_frames_replayed",
  "fm_last_errno",
  // Phase 6 D6.1 reference reconstruction (funcref + null):
  //  - `__wpk_fork_ref_decode_funcref` is the funcref-returning export the
  //    walrus injector adds (Rust cannot emit it); it reads the imported
  //    `__wpk_fork_function_catalog` table with `table.get`.
  //  - `fm_begin_reference_replay` seeds the funcref/null reference graph.
  //  - `fm_references_reconstructed` is the proof-of-use counter.
  "__wpk_fork_ref_decode_funcref",
  "fm_begin_reference_replay",
  "fm_references_reconstructed",
  // Phase 6 D6.2 externref reconstruction proof-of-use counter.
  "fm_externrefs_resolved",
  // Phase 6 D6.3a exnref reconstruction proof-of-use counter.
  "fm_exnrefs_reconstructed",
  // Phase 6 D6.4a typed-GC (struct/array/i31) reconstruction proof-of-use counter.
  "fm_gc_nodes_reconstructed",
  // Phase 6 item 3a (minimize host surface): the seven RESTORE data-feed exports
  // the host flips the guest's `__wpk_fork_ref_{vector_get,gc_route,
  // gc_payload_len,gc_load,exn_route,exn_load,exn_cache_index}` imports to
  // (per-activation, like `__wpk_fork_ref_decode_funcref`). They serve the
  // decoded reference graph to the guest's typed-GC/exnref codec during the JS
  // drive-order, moving that data feed out of the JS reference provider. Pure
  // i32/i64 signatures (see `host/src/generated/abi.ts`), so plain Rust exports.
  "fm_ref_vector_get",
  "fm_ref_gc_route",
  "fm_ref_gc_payload_len",
  "fm_ref_gc_load",
  "fm_ref_exn_route",
  "fm_ref_exn_load",
  "fm_ref_exn_cache_index",
  // Proof-of-use counter: advances once per data-feed read the module served, so
  // a test can prove the guest codec read the graph THROUGH the module rather
  // than the JS provider.
  "fm_ref_feed_reads",
] as const;

export type ForkModuleExportName = (typeof FORK_MODULE_REQUIRED_EXPORTS)[number];

export type ForkModuleExports = Record<ForkModuleExportName, Function> &
  WebAssembly.Exports;

export interface InstantiateForkModuleOptions {
  /** Pre-compiled fork-module (compiled once per kernel host). */
  module: WebAssembly.Module;
  /** The guest's single shared linear memory (the frame data plane). */
  memory: WebAssembly.Memory;
  /** Guest pointer width: 4 for wasm32, 8 for wasm64. */
  ptrWidth: 4 | 8;
  /**
   * Reserve `size` bytes in the shared linear memory and return the base
   * offset. Production supplies the channel `continuationMmap`; tests supply a
   * bump allocator. The base must be at least 16-byte aligned.
   */
  reserve: (size: number) => number;
  /** Diagnostic label (e.g. `pid=NN`). */
  label: string;
  /**
   * The funcref table the module's `__wpk_fork_ref_decode_funcref` reads with
   * `table.get` (Phase 6 D6.1). The guest's own `__wpk_fork_function_catalog` is
   * a guest EXPORT that only exists after the guest instance is created — which
   * is AFTER this module is instantiated (the module must precede the guest to
   * supply the frame-flip imports). So the host passes a growable, host-owned
   * mirror table here and populates it from the guest's catalog (identical
   * funcref identities) once the guest instance exists. When omitted (tests /
   * non-funcref paths) an empty growable table is created; the module never
   * reads it unless `fm_begin_reference_replay` succeeds and a funcref recipe is
   * decoded, so an empty table is inert.
   */
  functionCatalog?: WebAssembly.Table;
  /**
   * Real engine-floor `wpk_fork_host.*` import bodies (Phase 6 D6.2). The
   * co-resident module DECLARES the whole engine-floor seam
   * (`crates/fork-module/src/host_capabilities.rs`); its `WpkForkHost` routes
   * the seam's opaque `u32` ordinals across these imports to re-root externref
   * identity (through the broker token cache) and stage the anyref transit
   * during `fm_begin_reference_replay`. When provided, the named bodies back the
   * seam; when omitted (frame-only / funcref-only forks, and tests) every
   * `wpk_fork_host` import defaults to an inert `() => 0` stub. A funcref/null
   * graph opens no host generation and never calls them, so the inert default
   * keeps the D6.1 path and flag-off byte-identical.
   */
  hostCapabilities?: Readonly<Record<string, (...args: number[]) => number>>;
}

export interface ForkModuleInstance {
  instance: WebAssembly.Instance;
  exports: ForkModuleExports;
  /** First byte of the host-reserved region (== `__memory_base`). */
  memoryBase: number;
  /** Total reserved bytes: static/BSS footprint plus the shadow stack. */
  regionBytes: number;
  /** The module's own (empty) indirect function table. */
  table: WebAssembly.Table;
  /**
   * The funcref catalog table the module's `__wpk_fork_ref_decode_funcref`
   * reads (Phase 6 D6.1). The host populates this from the guest's
   * `__wpk_fork_function_catalog` export after the guest instance exists.
   */
  functionCatalog: WebAssembly.Table;
}

/**
 * Shadow stack for the fork-module's own Rust frames. The dylink `mem_size`
 * covers static data + BSS only; the imported `__stack_pointer` needs a
 * separate host-provided region. 1 MiB is generous for the small continuation
 * codec while staying far below the ~4 MiB static footprint.
 */
const FORK_MODULE_SHADOW_STACK_BYTES = 1 << 20;

const WASM_DYLINK_MEM_INFO = 1;

interface ForkModuleMemInfo {
  memorySize: number;
  memoryAlignBytes: number;
}

function readVarUint(data: Uint8Array, cursor: { value: number }): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[cursor.value++]!;
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result >>> 0;
}

/**
 * Read the `dylink.0` `mem_info` subsection from the compiled module. The
 * WebAssembly JS API hands back the section payload (the subsections) directly,
 * so no whole-file scan is needed.
 */
function readForkModuleMemInfo(
  module: WebAssembly.Module,
  label: string,
): ForkModuleMemInfo {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (sections.length === 0) {
    throw new Error(
      `${label}: fork-module is not a PIC side module (no dylink.0 section)`,
    );
  }
  const payload = new Uint8Array(sections[0]!);
  const cursor = { value: 0 };
  while (cursor.value < payload.length) {
    const subType = readVarUint(payload, cursor);
    const subSize = readVarUint(payload, cursor);
    const subEnd = cursor.value + subSize;
    if (subType === WASM_DYLINK_MEM_INFO) {
      const memorySize = readVarUint(payload, cursor);
      const memoryAlignLog2 = readVarUint(payload, cursor);
      return { memorySize, memoryAlignBytes: 1 << memoryAlignLog2 };
    }
    cursor.value = subEnd;
  }
  throw new Error(`${label}: fork-module dylink.0 has no mem_info subsection`);
}

function alignUp(value: number, alignBytes: number): number {
  return Math.ceil(value / alignBytes) * alignBytes;
}

function alignDown(value: number, alignBytes: number): number {
  return value - (value % alignBytes);
}

function wasmAddress(value: number, ptrWidth: 4 | 8): number | bigint {
  return ptrWidth === 8 ? BigInt(value) : value;
}

export function instantiateForkModule(
  options: InstantiateForkModuleOptions,
): ForkModuleInstance {
  const { module, memory, ptrWidth, reserve, label } = options;
  const memInfo = readForkModuleMemInfo(module, label);

  const staticBytes = alignUp(memInfo.memorySize, memInfo.memoryAlignBytes);
  const regionBytes = staticBytes + FORK_MODULE_SHADOW_STACK_BYTES;

  const memoryBase = reserve(regionBytes);
  if (!Number.isSafeInteger(memoryBase) || memoryBase < 0) {
    throw new Error(
      `${label}: fork-module reserve returned an invalid base ${memoryBase}`,
    );
  }
  if (memoryBase % memInfo.memoryAlignBytes !== 0) {
    throw new Error(
      `${label}: fork-module base 0x${memoryBase.toString(16)} is not aligned ` +
        `to ${memInfo.memoryAlignBytes}`,
    );
  }
  if (memoryBase + regionBytes > memory.buffer.byteLength) {
    throw new Error(
      `${label}: fork-module region [0x${memoryBase.toString(16)}, +${regionBytes}) ` +
        `exceeds shared memory of ${memory.buffer.byteLength} bytes`,
    );
  }

  // Shadow stack lives above the static footprint and grows down from the top.
  const stackTop = alignDown(memoryBase + regionBytes, 16);
  const pointerType = ptrWidth === 8 ? "i64" : "i32";

  const memoryBaseGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: false },
    wasmAddress(memoryBase, ptrWidth),
  );
  const tableBaseGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: false },
    wasmAddress(0, ptrWidth),
  );
  const stackPointerGlobal = new WebAssembly.Global(
    { value: pointerType, mutable: true },
    wasmAddress(stackTop, ptrWidth),
  );
  // The module declares table_size = 0, so it never adds entries. Give it its
  // own empty table rather than coupling to any guest table this step.
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  // The funcref catalog the module's `__wpk_fork_ref_decode_funcref` reads
  // (Phase 6 D6.1). Default to an empty GROWABLE table (no maximum) the host can
  // grow + populate from the guest's catalog once the guest instance exists.
  const functionCatalog =
    options.functionCatalog ??
    new WebAssembly.Table({ element: "anyfunc", initial: 0 });

  // The module DECLARES the `wpk_fork_host.*` engine-floor seam imports (Phase 6
  // D6, `crates/fork-module/src/host_capabilities.rs`). For the externref path
  // (D6.2) the caller supplies REAL bodies via `hostCapabilities`; otherwise
  // (frame-only / funcref-only forks, and tests) each import gets an inert
  // `() => 0` stub, which fits every signature (all return i32/u32) and is never
  // called because a funcref/null graph opens no host generation.
  const forkHostStubs: Record<string, (...args: number[]) => number> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== "wpk_fork_host") continue;
    forkHostStubs[imp.name] = options.hostCapabilities?.[imp.name] ?? (() => 0);
  }

  const imports: WebAssembly.Imports = {
    env: {
      memory,
      __indirect_function_table: table,
      __wpk_fork_function_catalog: functionCatalog,
      __memory_base: memoryBaseGlobal,
      __table_base: tableBaseGlobal,
      __stack_pointer: stackPointerGlobal,
    },
    wpk_fork_host: forkHostStubs,
  };

  // Synchronous instantiation runs the module's start (data-reloc / passive
  // segment copy into `__memory_base + offset`). Fail loud here, never later.
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(module, imports);
  } catch (error) {
    throw new Error(
      `${label}: fork-module instantiation failed: ${String(error)}`,
    );
  }

  const exports = instance.exports as ForkModuleExports;
  const missing = FORK_MODULE_REQUIRED_EXPORTS.filter(
    (name) => typeof exports[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `${label}: fork-module is missing required exports: ${missing.join(", ")}`,
    );
  }

  return { instance, exports, memoryBase, regionBytes, table, functionCatalog };
}
