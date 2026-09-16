/**
 * Placement primitives shared by every co-resident PIC side module.
 *
 * Kandelo runs more than one Rust side module inside a process worker's
 * address space: `crates/fork-module` (fork capture/replay) and
 * `crates/wasi-module` (the WASI Preview 1 personality). Both are built with
 * `-C relocation-model=pic --pie`, so neither carries absolute addresses: each
 * imports `__memory_base` / `__table_base` / `__stack_pointer` and relocates
 * its data segments into a region the HOST chooses, so its static data, BSS
 * and shadow stack never collide with live guest data.
 *
 * The reading of `dylink.0` and the arithmetic around it are identical for
 * both, which is exactly the kind of duplication this migration exists to
 * remove. They live here once rather than once per module.
 */

/** `WASM_DYLINK_MEM_INFO` subsection id from the dynamic-linking convention. */
const WASM_DYLINK_MEM_INFO = 1;

export interface SideModuleMemInfo {
  /** Bytes of static data + BSS the module needs at `__memory_base`. */
  memorySize: number;
  /** Required alignment of `__memory_base`, in bytes. */
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
 * Read the `dylink.0` `mem_info` subsection from a compiled side module.
 *
 * The WebAssembly JS API hands back the section payload (the subsections)
 * directly, so no whole-file scan is needed. A module without the section is
 * not position-independent, which is a build defect rather than something to
 * work around: report it loudly.
 */
export function readSideModuleMemInfo(
  module: WebAssembly.Module,
  label: string,
): SideModuleMemInfo {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (sections.length === 0) {
    throw new Error(
      `${label}: not a PIC side module (no dylink.0 section)`,
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
  throw new Error(`${label}: dylink.0 has no mem_info subsection`);
}

export function alignUp(value: number, alignBytes: number): number {
  return Math.ceil(value / alignBytes) * alignBytes;
}

export function alignDown(value: number, alignBytes: number): number {
  return value - (value % alignBytes);
}

/** Widen a host number into the wasm value type a `ptrWidth` global carries. */
export function wasmAddress(value: number, ptrWidth: 4 | 8): number | bigint {
  return ptrWidth === 8 ? BigInt(value) : value;
}

export interface SideModulePlacement {
  /** First byte of the host-reserved region (== `__memory_base`). */
  memoryBase: number;
  /** Bytes of static data + BSS, rounded up to the module's alignment. */
  staticBytes: number;
  /** The `env.__memory_base` immutable global. */
  memoryBaseGlobal: WebAssembly.Global;
  /** The `env.__table_base` immutable global. */
  tableBaseGlobal: WebAssembly.Global;
  /** The `env.__stack_pointer` mutable global, seeded at the region top. */
  stackPointerGlobal: WebAssembly.Global;
}

/**
 * Validate a reserved region and mint the three placement globals a PIC side
 * module imports.
 *
 * `regionBytes` is the caller's whole layout — static/BSS plus whatever the
 * module needs above it plus its shadow stack. The shadow stack grows DOWN
 * from the top of the region, so the caller must place everything else below
 * `stackTop` and size the region accordingly.
 */
export function placeSideModule(options: {
  memInfo: SideModuleMemInfo;
  memory: WebAssembly.Memory;
  ptrWidth: 4 | 8;
  memoryBase: number;
  regionBytes: number;
  label: string;
}): SideModulePlacement {
  const { memInfo, memory, ptrWidth, memoryBase, regionBytes, label } = options;
  const staticBytes = alignUp(memInfo.memorySize, memInfo.memoryAlignBytes);

  if (!Number.isSafeInteger(memoryBase) || memoryBase < 0) {
    throw new Error(`${label}: reserve returned an invalid base ${memoryBase}`);
  }
  if (memoryBase % memInfo.memoryAlignBytes !== 0) {
    throw new Error(
      `${label}: base 0x${memoryBase.toString(16)} is not aligned to ` +
        `${memInfo.memoryAlignBytes}`,
    );
  }
  if (memoryBase + regionBytes > memory.buffer.byteLength) {
    throw new Error(
      `${label}: region [0x${memoryBase.toString(16)}, +${regionBytes}) ` +
        `exceeds shared memory of ${memory.buffer.byteLength} bytes`,
    );
  }

  const stackTop = alignDown(memoryBase + regionBytes, 16);
  const pointerType = ptrWidth === 8 ? "i64" : "i32";

  return {
    memoryBase,
    staticBytes,
    memoryBaseGlobal: new WebAssembly.Global(
      { value: pointerType, mutable: false },
      wasmAddress(memoryBase, ptrWidth),
    ),
    tableBaseGlobal: new WebAssembly.Global(
      { value: pointerType, mutable: false },
      wasmAddress(0, ptrWidth),
    ),
    stackPointerGlobal: new WebAssembly.Global(
      { value: pointerType, mutable: true },
      wasmAddress(stackTop, ptrWidth),
    ),
  };
}
