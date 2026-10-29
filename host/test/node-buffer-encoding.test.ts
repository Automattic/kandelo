import { readFileSync } from "node:fs";
import { isAscii, isUtf8 } from "node:buffer";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Run the shared bootstrap's pure validators against Node's implementation.
// Guest-shell tests separately exercise their builtin exports and ESM linking.
const source = readFileSync(new URL("../../packages/registry/node-compat/bootstrap.js", import.meta.url), "utf8");
const start = source.indexOf("function _bufferInputBytes(");
const end = source.indexOf("const _builtinModules =", start);
if (start < 0 || end < 0) throw new Error("buffer validator source boundary missing");
const validators = runInNewContext(`${source.slice(start, end)}\n({isAscii:_bufferIsAscii,isUtf8:_bufferIsUtf8})`,
  { Uint8Array, ArrayBuffer, TypeError });

describe("Node buffer encoding validation", () => {
  it("agrees with Node for every one- and two-byte input", () => {
    for (let first = 0; first < 256; first++) {
      const single = Uint8Array.of(first);
      expect(validators.isAscii(single)).toBe(isAscii(single));
      expect(validators.isUtf8(single)).toBe(isUtf8(single));
      for (let second = 0; second < 256; second++) {
        const bytes = Uint8Array.of(first, second);
        if (validators.isUtf8(bytes) !== isUtf8(bytes)) throw new Error(`UTF-8 mismatch: ${bytes}`);
      }
    }
  });

  it("agrees with Node at multi-byte boundaries and on seeded arbitrary input", () => {
    const boundaries = [0, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xff];
    for (const a of boundaries) for (const b of boundaries) for (const c of boundaries) {
      const bytes = Uint8Array.of(a, b, c);
      if (validators.isUtf8(bytes) !== isUtf8(bytes)) throw new Error(`UTF-8 mismatch: ${bytes}`);
    }
    let seed = 20261020;
    for (let i = 0; i < 10_000; i++) {
      const bytes = new Uint8Array(i % 12);
      for (let j = 0; j < bytes.length; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        bytes[j] = seed >>> 24;
      }
      expect(validators.isUtf8(bytes)).toBe(isUtf8(bytes));
      expect(validators.isAscii(bytes)).toBe(isAscii(bytes));
    }
  });

  it("respects view bounds and rejects invalid and detached inputs", () => {
    const bytes = Uint8Array.of(0xff, 0x61, 0xff);
    for (const value of [new ArrayBuffer(0), bytes.buffer, bytes.subarray(1, 2), new SharedArrayBuffer(4), runInNewContext('new ArrayBuffer(4)'), runInNewContext('new SharedArrayBuffer(4)'), runInNewContext('new Uint8Array([97])')]) {
      expect(validators.isUtf8(value)).toBe(isUtf8(value));
      expect(validators.isAscii(value)).toBe(isAscii(value));
    }
    const detached = new ArrayBuffer(8);
    const view = new Uint8Array(detached);
    structuredClone(detached, { transfer: [detached] });
    for (const fn of [validators.isUtf8, validators.isAscii]) {
      for (const value of [null, undefined, "", 42, [], {}, new DataView(bytes.buffer), detached, view]) {
        expect(() => fn(value)).toThrow(TypeError);
      }
    }
  });
});
