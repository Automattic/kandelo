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
  "fm_set_format",
  "fm_begin_unwind",
  "fm_finish_unwind",
  "fm_begin_replay",
  "fm_finish_replay",
  "fm_last_errno",
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

  const imports: WebAssembly.Imports = {
    env: {
      memory,
      __indirect_function_table: table,
      __memory_base: memoryBaseGlobal,
      __table_base: tableBaseGlobal,
      __stack_pointer: stackPointerGlobal,
    },
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

  return { instance, exports, memoryBase, regionBytes, table };
}
