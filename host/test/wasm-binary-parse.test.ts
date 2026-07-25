/**
 * Unit tests for `extractHeapBase` and `extractAbiVersion` in
 * `host/src/constants.ts`. These parsers are on the host's hot path
 * for spawn/exec — every program load reads `__heap_base` to install
 * the kernel's initial brk before `_start` runs (see
 * `kernel_set_brk_base` in `crates/kernel/src/wasm_api.rs`).
 *
 * Tests construct minimal wasm binaries inline so they don't depend
 * on cached package binaries.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ABI_VERSION,
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
} from "../src/generated/abi";
import {
  describeWasmArtifactPolicyFailures,
  extractHeapBase,
  extractAbiVersion,
  extractThreadSlotDeclaration,
  wasmContainsLegacyAsyncify,
  wasmIsRelocatableObject,
  readWasmCustomSectionNames,
  readWasmExportNames,
  readWasmImportNames,
  wasmHasCompleteForkInstrumentation,
  wasmImportsKernelFork,
} from "../src/constants";
import { tryResolveBinary } from "../src/binary-resolver";

// ---------------------------------------------------------------------------
// Minimal wasm-binary builder
// ---------------------------------------------------------------------------

function uleb128(n: number): number[] {
  const r: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    r.push(b);
  } while (n !== 0);
  return r;
}

function sleb128_i32(n: number): number[] {
  const r: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      r.push(b);
      return r;
    }
    r.push(b | 0x80);
  }
}

function sleb128_i64(n: bigint): number[] {
  const r: number[] = [];
  for (;;) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) {
      r.push(b);
      return r;
    }
    r.push(b | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(s: string): number[] {
  const enc = new TextEncoder().encode(s);
  return [...uleb128(enc.length), ...enc];
}

interface GlobalImport { module: string; name: string; valType: 0x7F | 0x7E; mut: 0 | 1; }
interface FuncImport { module: string; name: string; typeIdx: number; }
interface DefinedGlobal { valType: 0x7F | 0x7E; mut: 0 | 1; init: number[]; }
interface ExportEntry { name: string; kind: 0 | 1 | 2 | 3; index: number; }
interface FuncBody { locals: number[]; instructions: number[]; }

function buildWasm(opts: {
  funcImports?: FuncImport[];
  globalImports?: GlobalImport[];
  types?: { params: number[]; results: number[] }[];
  funcTypes?: number[];        // type index per defined function
  memoryPointerWidths?: Array<4 | 8>;
  globals?: DefinedGlobal[];
  exports?: ExportEntry[];
  funcBodies?: FuncBody[];
  customSections?: { name: string; data?: number[] }[];
}): ArrayBuffer {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];

  for (const custom of opts.customSections ?? []) {
    bytes.push(...section(0, [...nameBytes(custom.name), ...(custom.data ?? [])]));
  }

  // Default to one `() -> i32` type so __abi_version-like funcs work.
  const types = opts.types ?? [{ params: [], results: [0x7F] }];
  const typePayload = [...uleb128(types.length)];
  for (const type of types) {
    typePayload.push(
      0x60,
      ...uleb128(type.params.length),
      ...type.params,
      ...uleb128(type.results.length),
      ...type.results,
    );
  }
  bytes.push(...section(1, typePayload));

  // Import section (id=2)
  const fImps = opts.funcImports ?? [];
  const gImps = opts.globalImports ?? [];
  if (fImps.length + gImps.length > 0) {
    const payload: number[] = [...uleb128(fImps.length + gImps.length)];
    for (const fi of fImps) {
      payload.push(...nameBytes(fi.module), ...nameBytes(fi.name), 0x00, ...uleb128(fi.typeIdx));
    }
    for (const gi of gImps) {
      payload.push(...nameBytes(gi.module), ...nameBytes(gi.name), 0x03, gi.valType, gi.mut);
    }
    bytes.push(...section(2, payload));
  }

  // Function section (id=3) — type indices for defined functions
  const fTypes = opts.funcTypes ?? [];
  if (fTypes.length > 0) {
    const payload: number[] = [...uleb128(fTypes.length)];
    for (const t of fTypes) payload.push(...uleb128(t));
    bytes.push(...section(3, payload));
  }

  const memoryPointerWidths = opts.memoryPointerWidths ?? [];
  if (memoryPointerWidths.length > 0) {
    const payload = [...uleb128(memoryPointerWidths.length)];
    for (const pointerWidth of memoryPointerWidths) {
      payload.push(pointerWidth === 8 ? 0x04 : 0x00, 0x01);
    }
    bytes.push(...section(5, payload));
  }

  // Global section (id=6)
  const gs = opts.globals ?? [];
  if (gs.length > 0) {
    const payload: number[] = [...uleb128(gs.length)];
    for (const g of gs) {
      payload.push(g.valType, g.mut, ...g.init, 0x0B);
    }
    bytes.push(...section(6, payload));
  }

  // Export section (id=7)
  const es = opts.exports ?? [];
  if (es.length > 0) {
    const payload: number[] = [...uleb128(es.length)];
    for (const e of es) {
      payload.push(...nameBytes(e.name), e.kind, ...uleb128(e.index));
    }
    bytes.push(...section(7, payload));
  }

  // Code section (id=10)
  const bodies = opts.funcBodies ?? [];
  if (bodies.length > 0) {
    const payload: number[] = [...uleb128(bodies.length)];
    for (const b of bodies) {
      const body: number[] = [...b.locals, ...b.instructions, 0x0B];
      payload.push(...uleb128(body.length), ...body);
    }
    bytes.push(...section(10, payload));
  }

  return new Uint8Array(bytes).buffer;
}

const I32 = 0x7F;
const I64 = 0x7E;

function linkedFrameDescriptor(pointerWidth: 4 | 8): number[] {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  );
  if (!pointerFormat) throw new Error(`unsupported pointer width ${pointerWidth}`);
  const bytes = new Uint8Array(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
  bytes.set(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, true);
  view.setUint8(8, pointerWidth);
  view.setUint8(9, WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT);
  view.setUint16(10, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, true);
  view.setUint32(12, pointerFormat.chunkHeaderSize, true);
  view.setUint32(16, pointerFormat.nodeHeaderSize, true);
  view.setUint32(20, 16, true);
  return [...bytes];
}

function completeForkWasm(options: {
  pointerWidth?: 4 | 8;
  memoryPointerWidth?: 4 | 8;
  exportPointerWidth?: 4 | 8;
} = {}): ArrayBuffer {
  const pointerWidth = options.pointerWidth ?? 4;
  const pointerType = pointerWidth === 8 ? I64 : I32;
  const exportPointerType = (options.exportPointerWidth ?? pointerWidth) === 8 ? I64 : I32;
  const types = [
    { params: [], results: [I32] },
    { params: [exportPointerType], results: [] },
    { params: [], results: [] },
    { params: [pointerType], results: [pointerType] },
    { params: [pointerType], results: [] },
  ];
  const funcImports: FuncImport[] = [
    { module: "kernel", name: "kernel_fork", typeIdx: 0 },
    ...WPK_FORK_REQUIRED_IMPORTS.map((requirement) => ({
      module: requirement.module,
      name: requirement.name,
      typeIdx: requirement.results.length === 1 ? 3 : 4,
    })),
  ];
  const forkTypeIndices = WPK_FORK_REQUIRED_EXPORTS.map((requirement) => {
    if (requirement.results.length === 1) return 0;
    return requirement.params.length === 1 ? 1 : 2;
  });
  const firstDefinedFunction = funcImports.length;
  return buildWasm({
    customSections: [{
      name: WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
      data: linkedFrameDescriptor(pointerWidth),
    }],
    types,
    funcImports,
    funcTypes: [...forkTypeIndices, 0],
    memoryPointerWidths: [options.memoryPointerWidth ?? pointerWidth],
    exports: [
      ...WPK_FORK_REQUIRED_EXPORTS.map((requirement, index) => ({
        name: requirement.name,
        kind: 0 as const,
        index: firstDefinedFunction + index,
      })),
      {
        name: "__abi_version",
        kind: 0,
        index: firstDefinedFunction + forkTypeIndices.length,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// extractHeapBase
// ---------------------------------------------------------------------------

describe("extractHeapBase", () => {
  it("returns null for an empty/too-short binary", () => {
    expect(extractHeapBase(new ArrayBuffer(0))).toBeNull();
    expect(extractHeapBase(new ArrayBuffer(4))).toBeNull();
  });

  it("returns null when no __heap_base export is present", () => {
    const wasm = buildWasm({
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(0x100000)] }],
      exports: [{ name: "other", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });

  it("reads an i32 __heap_base from a defined global (wasm32)", () => {
    const wasm = buildWasm({
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(17_106_736)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBe(17_106_736n);
  });

  it("reads an i32 __heap_base above the import-global offset", () => {
    // 1 imported global (index 0) + 1 defined global (index 1) → __heap_base = global 1
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "__channel_base", valType: I32, mut: 1 }],
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(0x1051D70)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 1 }],
    });
    expect(extractHeapBase(wasm)).toBe(0x1051D70n);
  });

  it("reads an i64 __heap_base for wasm64", () => {
    const expected = 0x100000000n; // 4 GiB
    const wasm = buildWasm({
      globals: [{ valType: I64, mut: 0, init: [0x42, ...sleb128_i64(expected)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBe(expected);
  });

  it("returns null when __heap_base is imported (no init expression to read)", () => {
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "__heap_base", valType: I32, mut: 0 }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });

  it("returns null for a non-const init expression", () => {
    // 0x23 = global.get; an unsupported init form for our purposes.
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "src", valType: I32, mut: 0 }],
      globals: [{ valType: I32, mut: 0, init: [0x23, ...uleb128(0)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 1 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAbiVersion
// ---------------------------------------------------------------------------

function abiVersionBody(value: number): FuncBody {
  // Mirrors what libc/glue/channel_syscall.c emits: __wasm_call_ctors prefix
  // (call <ctors-func-idx>) then `i32.const value`.
  return {
    locals: [0x00],                                // 0 local groups
    instructions: [
      0x10, ...uleb128(0),                          // call func 0 (the ctors stub)
      0x41, ...sleb128_i32(value),                  // i32.const value
    ],
  };
}

describe("extractAbiVersion", () => {
  it("returns null for an empty binary", () => {
    expect(extractAbiVersion(new ArrayBuffer(0))).toBeNull();
  });

  it("returns null when no __abi_version export is present", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "_start", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBeNull();
  });

  it("reads the i32.const after the ctors-call prefix", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(7);
  });

  it("handles the export wrapper for older ABI values", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(6)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(6);
  });

  it("ignores instrumentation constants before the ABI return value", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [{
        locals: [0x00],
        instructions: [
          0x02, 0x40,              // block
          0x41, ...sleb128_i32(2), // instrumentation constant
          0x1a,                    // drop
          0x0b,                    // end block
          0x10, ...uleb128(0),      // call ctors stub
          0x41, ...sleb128_i32(12), // actual ABI version
          0x0f,                    // return
        ],
      }],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(12);
  });

  it("follows an instrumented command-export wrapper to the real ABI marker", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [
        {
          locals: [0x00],
          instructions: [
            0x02, 0x40,               // block
            0x41, ...sleb128_i32(2),  // fork-state constant
            0x1a,                     // drop
            0x0b,                     // end block
            0x10, ...uleb128(1),      // call real marker
            0x0f,                     // return
            0x41, ...sleb128_i32(0),  // wrapper default path, not ABI
          ],
        },
        {
          locals: [0x00],
          instructions: [
            0x41, ...sleb128_i32(12),
          ],
        },
      ],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(12);
  });

  it("counts function imports correctly when computing the body index", () => {
    // 1 func import (index 0) + 1 defined function (index 1) → __abi_version = func 1
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_get_argc", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });
    expect(extractAbiVersion(wasm)).toBe(7);
  });
});

describe("extractThreadSlotDeclaration", () => {
  it("returns null when the process-wasm declaration export is absent", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(-1)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractThreadSlotDeclaration(wasm)).toBeNull();
  });

  it("reads the signed i32 thread slot declaration", () => {
    for (const value of [-1, 0, 3]) {
      const wasm = buildWasm({
        funcTypes: [0],
        funcBodies: [abiVersionBody(value)],
        exports: [{ name: "__wasm_posix_thread_slots", kind: 0, index: 0 }],
      });
      expect(extractThreadSlotDeclaration(wasm)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Wasm artifact policy helpers
// ---------------------------------------------------------------------------

describe("wasm artifact policy helpers", () => {
  it("reads import and export names without compiling the module", () => {
    const wasm = buildWasm({
      funcImports: [
        { module: "kernel", name: "kernel_fork", typeIdx: 0 },
        { module: "kernel", name: "kernel_clone", typeIdx: 0 },
      ],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 2 },
        { name: "wpk_fork_state", kind: 0, index: 2 },
      ],
    });

    expect(readWasmImportNames(wasm)).toEqual([
      "kernel.kernel_fork",
      "kernel.kernel_clone",
    ]);
    expect(readWasmExportNames(wasm)).toContain("wpk_fork_state");
    expect(wasmImportsKernelFork(wasm)).toBe(true);
  });

  it("flags fork-capable wasm without the complete instrumentation exports", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 1 },
        { name: "wpk_fork_state", kind: 0, index: 1 },
      ],
    });

    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    const failures = describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 });
    expect(failures).toContain(
      "incomplete wasm-fork-instrument exports; missing wpk_fork_abort_begin, wpk_fork_abort_end, wpk_fork_rewind_begin, wpk_fork_rewind_end, wpk_fork_unwind_begin, wpk_fork_unwind_end",
    );
    expect(failures).toContain(
      `missing required ${WPK_FORK_LINKED_FRAME_FORMAT_SECTION} descriptor`,
    );
    expect(failures).toContain(
      "incomplete ABI 42 linked-frame imports; missing env.__wpk_fork_frame_commit, env.__wpk_fork_frame_next, env.__wpk_fork_frame_reserve",
    );
  });

  it("accepts the complete ABI 42 contract for wasm32 and wasm64", () => {
    for (const pointerWidth of [4, 8] as const) {
      const wasm = completeForkWasm({ pointerWidth });
      expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(true);
      expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 })).toEqual([]);
    }
  });

  it("rejects descriptor and module-memory pointer-width drift", () => {
    const wasm = completeForkWasm({ pointerWidth: 8, memoryPointerWidth: 4 });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 42 linked-frame descriptor declares an 8-byte pointer but the module memory uses 4-byte addresses",
    );
  });

  it("rejects function signatures that drift from the descriptor pointer width", () => {
    const wasm = completeForkWasm({ pointerWidth: 8, exportPointerWidth: 4 });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 42 wasm-fork-instrument export wpk_fork_abort_begin has the wrong signature; expected (i64) -> ()",
    );
  });

  it("does not require fork instrumentation for thread-only kernel_clone imports", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_clone", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(wasmImportsKernelFork(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 })).toEqual([]);
  });

  it("flags missing required exports", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requiredExports: ["__abi_version", "kernel_host_adapter_manifest_ptr"],
    })).toEqual([
      "missing required exports: kernel_host_adapter_manifest_ptr",
    ]);
  });

  it("flags executable wasm missing the ABI and entrypoint exports", () => {
    const wasm = buildWasm({});

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requiredExports: ["__abi_version", "_start"],
    })).toEqual([
      "missing required exports: __abi_version, _start",
    ]);
  });

  it("does not require fork instrumentation for relocatable wasm objects", () => {
    const wasm = buildWasm({
      customSections: [{ name: "linking" }, { name: "reloc.CODE" }],
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(readWasmCustomSectionNames(wasm)).toContain("linking");
    expect(wasmIsRelocatableObject(wasm)).toBe(true);
    expect(wasmImportsKernelFork(wasm)).toBe(true);
    expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 })).toEqual([]);
  });

  it("allows fork imports when an output explicitly disables fork instrumentation", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requireForkInstrumentation: false,
      forbidForkInstrumentation: true,
    })).toEqual([]);
  });

  it("rejects fork instrumentation when an output disables it", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 1 },
        { name: "wpk_fork_unwind_begin", kind: 0, index: 1 },
        { name: "wpk_fork_unwind_end", kind: 0, index: 1 },
        { name: "wpk_fork_rewind_begin", kind: 0, index: 1 },
        { name: "wpk_fork_rewind_end", kind: 0, index: 1 },
        { name: "wpk_fork_state", kind: 0, index: 1 },
      ],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requireForkInstrumentation: false,
      forbidForkInstrumentation: true,
    })).toContain("contains ABI 42 wasm-fork-instrument metadata, imports, or exports");
  });
});

const builtNodeBinary = join(process.cwd(), "..", "packages/registry/spidermonkey-node/bin/node.wasm");

describe.skipIf(!existsSync(builtNodeBinary))("built node.wasm artifact policy", () => {
  it("uses the SpiderMonkey no-fork-instrumentation policy", () => {
    const bytes = readFileSync(builtNodeBinary);
    const wasm = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
      requireForkInstrumentation: false,
      forbidForkInstrumentation: true,
    })).toEqual([]);
    expect(wasmContainsLegacyAsyncify(wasm)).toBe(false);
    expect(readWasmExportNames(wasm).filter((name) => name.startsWith("wpk_fork_"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: cross-check against real cached binaries via wasm-objdump.
// Skipped when wasm-objdump or the cache is unavailable.
// ---------------------------------------------------------------------------

function hasWasmObjdump(): boolean {
  try {
    execFileSync("wasm-objdump", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function objdumpHeapBase(path: string): bigint | null {
  const out = execFileSync("wasm-objdump", ["-j", "Global", "-x", path], { encoding: "utf-8" });
  const m = out.match(/<__heap_base>\s*-\s*init\s+i(?:32|64)=(-?\d+)/);
  return m ? BigInt(m[1]) : null;
}

/**
 * Walk the package cache for any `*.wasm` file matching `name`. The cache
 * uses content-addressed directories like `programs/<pkg>-rev<N>-<arch>-<hash>/`.
 * Returns the first match by default-arch (wasm32) preference.
 */
function findCachedBinary(name: string, arch = "wasm32"): string | null {
  const cacheRoot = join(homedir(), ".cache/kandelo/programs");
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!dir.includes(`-${arch}-`)) continue;
    const candidate = join(cacheRoot, dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const localDashBinary = tryResolveBinary("programs/dash.wasm");
const dashBinary = (localDashBinary && existsSync(localDashBinary))
  ? localDashBinary
  : findCachedBinary("dash.wasm");
const haveTooling = hasWasmObjdump() && !!dashBinary && existsSync(dashBinary);

describe.skipIf(!haveTooling)("extractHeapBase against cached binaries", () => {
  it("matches wasm-objdump for dash.wasm", () => {
    const bytes = readFileSync(dashBinary!);
    const arr = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ours = extractHeapBase(arr);
    const expected = objdumpHeapBase(dashBinary!);
    expect(ours).not.toBeNull();
    expect(ours).toBe(expected);
  });
});
