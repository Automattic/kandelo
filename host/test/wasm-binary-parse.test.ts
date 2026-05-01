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
import { extractHeapBase, extractAbiVersion } from "../src/constants";
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
  funcTypes?: number[];        // type index per defined function
  globals?: DefinedGlobal[];
  exports?: ExportEntry[];
  funcBodies?: FuncBody[];
}): ArrayBuffer {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];

  // Type section (id=1): one type `() -> i32` so __abi_version-like funcs work.
  // Encoded: count=1, [0x60 (func), 0 params, 1 result, 0x7F i32]
  bytes.push(...section(1, [0x01, 0x60, 0x00, 0x01, 0x7F]));

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
  // Mirrors what glue/channel_syscall.c emits: __wasm_call_ctors prefix
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
  const cacheRoot = join(homedir(), ".cache/wasm-posix-kernel/programs");
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
