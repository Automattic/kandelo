import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SNAPSHOT_COMPARATOR_BYTES, SNAPSHOT_COMPARATOR_GENERATOR_SHA256, SNAPSHOT_COMPARATOR_TEMPLATE_SHA256 } from "../src/generated/process-snapshot-comparator-bytes";
import { getSnapshotComparatorModule, lookupComparisonMemoryShape, recordComparisonMemoryShape } from "../src/process-snapshot-comparator";

function memory(width: 4 | 8, shared: boolean) {
  const descriptor = width === 8
    ? { initial: 2n, maximum: 3n, shared, address: "i64" }
    : { initial: 2, maximum: 3, shared };
  const result = new WebAssembly.Memory(descriptor as WebAssembly.MemoryDescriptor);
  recordComparisonMemoryShape(result, width, shared, 3);
  return result;
}

describe("fixed read-only process snapshot comparator", () => {
  it("authenticates native shared backing when the global SharedArrayBuffer constructor is absent", async () => {
    const shared = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    const privateMemory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const nativeBacking = shared.buffer;
    const backingLength = vi.spyOn(Object.getPrototypeOf(nativeBacking), "byteLength", "get");
    vi.resetModules();
    vi.stubGlobal("SharedArrayBuffer", undefined);
    try {
      const helper = await import("../src/process-snapshot-comparator");
      // Public properties are not authority for the native Memory or backing.
      Object.defineProperty(shared, "buffer", { get() { throw Error("public buffer getter"); } });
      backingLength.mockImplementation(() => { throw Error("public backing length getter"); });
      helper.recordComparisonMemoryShape(shared, 4, true, 2);
      helper.recordComparisonMemoryShape(privateMemory, 4, false, 2);
      expect(helper.lookupComparisonMemoryShape(shared)).toEqual({ addressWidth: 4, shared: true, maximumPages: 2 });
      expect(() => helper.recordComparisonMemoryShape({ buffer: privateMemory.buffer } as any, 4, false, 2)).toThrow();
      expect(() => helper.recordComparisonMemoryShape(new Proxy(shared, {}), 4, true, 2)).toThrow();
      const wrongSharing = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
      expect(() => helper.recordComparisonMemoryShape(wrongSharing, 4, false, 2)).toThrow();
      expect(() => helper.recordComparisonMemoryShape(wrongSharing, 4, true, 0)).toThrow();
      shared.grow(1);
      helper.recordComparisonMemoryShape(shared, 4, true, 2);
      const selected = helper.getSnapshotComparatorModule(helper.lookupComparisonMemoryShape(privateMemory), helper.lookupComparisonMemoryShape(shared));
      expect(selected).toBeInstanceOf(WebAssembly.Module);
      const compare = new WebAssembly.Instance(selected!, { env: { kernel: privateMemory, process: shared } }).exports.compare as Function;
      expect(compare(0n, 0n, 17)).toBe(0);
      new Uint8Array(nativeBacking)[16] = 1;
      expect(compare(0n, 0n, 17)).toBe(1);
    } finally {
      backingLength.mockRestore();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("matches its generator and has only two memory imports and one read-only function", () => {
    const hash = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");
    expect(hash(new URL("../scripts/generate-snapshot-comparator.mjs", import.meta.url))).toBe(SNAPSHOT_COMPARATOR_GENERATOR_SHA256);
    expect(hash(new URL("../scripts/snapshot-comparator.wat", import.meta.url))).toBe(SNAPSHOT_COMPARATOR_TEMPLATE_SHA256);
    const directory = mkdtempSync(join(tmpdir(), "kandelo-comparison-audit-"));
    try {
      expect(Object.keys(SNAPSHOT_COMPARATOR_BYTES)).toHaveLength(32);
      for (const [key, dense] of Object.entries(SNAPSHOT_COMPARATOR_BYTES)) {
        const bytes = Uint8Array.from(dense);
        expect(WebAssembly.validate(bytes), key).toBe(true);
        const module = new WebAssembly.Module(bytes);
        expect(WebAssembly.Module.imports(module), key).toEqual([
          { module: "env", name: "kernel", kind: "memory" },
          { module: "env", name: "process", kind: "memory" },
        ]);
        expect(WebAssembly.Module.exports(module), key).toEqual([{ name: "compare", kind: "function" }]);
        const path = join(directory, key + ".wasm");
        writeFileSync(path, bytes);
        const wat = execFileSync("wasm2wat", ["--enable-all", path], { encoding: "utf8" });
        expect(wat.match(/\(memory /g), key).toHaveLength(2);
        expect(wat.match(/^  \(func /gm), key).toHaveLength(1); // exactly one function definition
        expect(wat, key).not.toMatch(/\((?:start|data|elem)\b|\b(?:memory\.(?:grow|copy|fill|init)|[\w.]*store[\w.]*|[\w.]*atomic[\w.]*)\b/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compares distinct memories for every native width/sharing pair, SIMD and scalar", () => {
    for (const kw of [4, 8] as const) for (const ks of [false, true])
      for (const pw of [4, 8] as const) for (const ps of [false, true]) {
        const kernel = memory(kw, ks), process = memory(pw, ps);
        const left = new Uint8Array(kernel.buffer), right = new Uint8Array(process.buffer);
        const selected = getSnapshotComparatorModule(lookupComparisonMemoryShape(kernel), lookupComparisonMemoryShape(process));
        expect(selected).toBeInstanceOf(WebAssembly.Module);
        expect(getSnapshotComparatorModule(lookupComparisonMemoryShape(kernel), lookupComparisonMemoryShape(process))).toBe(selected);
        for (const mode of ["simd", "scalar"]) {
          const key = `k${kw * 8}${ks ? "s" : "u"}-p${pw * 8}${ps ? "s" : "u"}-${mode}`;
          const module = new WebAssembly.Module(Uint8Array.from(SNAPSHOT_COMPARATOR_BYTES[key]));
          const compare = new WebAssembly.Instance(module, { env: { kernel, process } }).exports.compare as (a: bigint, b: bigint, n: number) => number;
          for (const [a, b] of [[0, 4096], [4097, 3], [65521, 65523]]) {
            for (const n of [0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33, 257, 4097]) {
              const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 19) & 255);
              left.set(bytes, a); right.set(bytes, b);
              expect(compare(BigInt(a), BigInt(b), n), key).toBe(0);
              for (const position of new Set(n ? [0, Math.floor(n / 2), n - 1] : [])) {
                right[b + position] ^= 255;
                expect(compare(BigInt(a), BigInt(b), n), key).toBe(1);
                expect(left.slice(a, a + n), key).toEqual(bytes);
                right[b + position] ^= 255;
              }
            }
          }
          // No speculative vector/word load may cross an exact end-of-memory tail.
          for (const n of [0, 1, 7, 8, 15, 16, 17]) {
            left.fill(23, left.length - n); right.fill(23, right.length - n);
            expect(compare(BigInt(left.length - n), BigInt(right.length - n), n), key).toBe(0);
          }
        }
      }
  });

  it("uses scalar Wasm when SIMD is unavailable and reports complete unavailability", async () => {
    const nativeValidate = WebAssembly.validate;
    for (const scalarAvailable of [true, false]) {
      vi.resetModules();
      let validations = 0;
      const validate = vi.spyOn(WebAssembly, "validate").mockImplementation(bytes => {
        validations++;
        return validations === 1 ? false : scalarAvailable && nativeValidate(bytes);
      });
      try {
        const helper = await import("../src/process-snapshot-comparator");
        const left = new WebAssembly.Memory({ initial: 1, maximum: 2 });
        const right = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
        helper.recordComparisonMemoryShape(left, 4, false, 2);
        helper.recordComparisonMemoryShape(right, 4, true, 2);
        const a = helper.lookupComparisonMemoryShape(left), b = helper.lookupComparisonMemoryShape(right);
        const module = helper.getSnapshotComparatorModule(a, b);
        expect(validations).toBe(2);
        if (scalarAvailable) {
          expect(module).toBeInstanceOf(WebAssembly.Module);
          const compare = new WebAssembly.Instance(module!, { env: { kernel: left, process: right } }).exports.compare as Function;
          expect(compare(0n, 0n, 33)).toBe(0);
          new Uint8Array(right.buffer)[32] = 1;
          expect(compare(0n, 0n, 33)).toBe(1);
        } else expect(module).toBeUndefined();
        expect(helper.getSnapshotComparatorModule(a, b)).toBe(module);
        expect(validations).toBe(2); // compiled modules/unavailability only, no instance cache
      } finally {
        validate.mockRestore();
      }
    }
  });

  it("keeps metadata scalar, immutable, authenticated and absent for unknown factories", () => {
    const guest = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    expect(lookupComparisonMemoryShape(guest)).toBeUndefined();
    expect(getSnapshotComparatorModule(undefined, undefined)).toBeUndefined();
    expect(getSnapshotComparatorModule({ get addressWidth() { throw Error("hostile descriptor"); } } as any, undefined)).toBeUndefined();
    expect(() => recordComparisonMemoryShape({ buffer: guest.buffer } as any, 4, true, 2)).toThrow();
    expect(() => recordComparisonMemoryShape(guest, 4, false, 2)).toThrow();
    expect(() => recordComparisonMemoryShape(guest, 4, true, 0)).toThrow();
    recordComparisonMemoryShape(guest, 4, true, 2);
    expect(lookupComparisonMemoryShape(guest)).toEqual({ addressWidth: 4, shared: true, maximumPages: 2 });
    expect(Object.isFrozen(lookupComparisonMemoryShape(guest))).toBe(true);
    recordComparisonMemoryShape(guest, 4, true, 2);
    expect(() => recordComparisonMemoryShape(guest, 8, true, 2)).toThrow(/cannot change/);
    guest.grow(1);
    expect(lookupComparisonMemoryShape(guest)?.maximumPages).toBe(2);
  });
});
