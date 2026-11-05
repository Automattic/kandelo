import { Buffer as NativeBuffer, isLatin1 as nativeIsLatin1 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const { Buffer, isLatin1 } = process.versions.node === target.version ?
  require('./fixtures/node-buffer-codecs.cjs').create() : { Buffer: undefined, isLatin1: undefined };
function outcome(fn: () => any) {
  try {
    const value = fn();
    return { value: ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value };
  } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; }
}
const encodings = ['utf8', 'UTF-8', 'ascii', 'latin1', 'binary', 'ucs2', 'utf-16le',
  'hex', 'base64', 'base64url'];
const strings = ['', 'abc\0x', '\ufeff€😀', '\ud800x\udfff', '\ud800\ud800\udc00', '\u0080ÿĀ',
  '00ff12ag', 'abc', 'ab!cd', 'Y Q==junk', '-_8/', 'YQ=Q', 'Y', '====', 'a\u0141\u013d',
  '\u0130\u0146', '0\u0146', '\u0000Zg\n=='];
describe.skipIf(process.versions.node !== target.version)('pinned Buffer codec owner', () => {
  it('encodes and counts strings with target aliases, malformed input and surrogate policy', () => {
    for (const string of strings) for (const encoding of [...encodings, 'unknown', '', undefined, null, 1]) {
      expect(outcome(() => Buffer.from(string, encoding)), `${JSON.stringify(string)} ${encoding}`)
        .toEqual(outcome(() => NativeBuffer.from(string, encoding as any)));
      expect(outcome(() => Buffer.byteLength(string, encoding)))
        .toEqual(outcome(() => NativeBuffer.byteLength(string, encoding as any)));
    }
    for (const value of [null, undefined, 1, {}, new Uint16Array(3), new DataView(new ArrayBuffer(3)),
      new ArrayBuffer(3), new SharedArrayBuffer(3)])
      expect(outcome(() => Buffer.byteLength(value))).toEqual(outcome(() => NativeBuffer.byteLength(value as any)));
  });
  it('writes whole UTF-8/UTF-16 characters, preserves untouched bytes and validates overloads', () => {
    for (const string of strings) for (const encoding of encodings) for (let length = 0; length <= 7; length++) {
      const a = Buffer.alloc(9, 0xaa), b = NativeBuffer.alloc(9, 0xaa);
      expect(outcome(() => a.write(string, 1, length, encoding)), `${JSON.stringify(string)} ${encoding} ${length}`)
        .toEqual(outcome(() => b.write(string, 1, length, encoding as any)));
      expect([...a]).toEqual([...b]);
    }
    for (const args of [[], ['utf8'], [0], [1, 'hex'], [-1], [1.5], [10], [null],
      [0, -1], [0, 1.5], [0, 10], [0, 'unknown'], [Symbol('offset')]]) {
      const a = Buffer.alloc(9), b = NativeBuffer.alloc(9);
      expect(outcome(() => a.write('éab', ...args))).toEqual(outcome(() => (b.write as any)('éab', ...args)));
      expect([...a]).toEqual([...b]);
    }
  });
  it('decodes all two-byte inputs plus malformed and boundary UTF-8 prefixes exactly', () => {
    // Hash framed output only to keep all 65,536 observations bounded in memory.
    // The native control receives the identical bytes; no assertion is replaced.
    function digest(B: any) {
      const hash = createHash('sha256');
      for (let i = 0; i < 65536; i++) {
        const value = B.from([i >>> 8, i & 255]);
        hash.update(JSON.stringify([value.toString(), B.stringLength(value)]));
      }
      for (const input of [[0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xef, 0xbb, 0xbf],
        [0xe2, 0x82], [0xe2, 0x82, 0x41], [0xf0, 0x9f, 0x98], [0xf0, 0x9f, 0x98, 0x80],
        [0xf4, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xf0, 0x80, 0x80, 0x80]]) {
        const value = B.from(input);
        hash.update(JSON.stringify([value.toString(), B.stringLength(value)]));
      }
      return hash.digest('hex');
    }
    expect(digest(Buffer)).toBe(digest(NativeBuffer));
  });
  it('decodes raw bytes and counts output code units with target ranges and brands', () => {
    const a = Buffer.from([0, 0xff, 0x80, 0x41, 0, 0xd8, 0xef, 0xbb, 0xbf]);
    const b = NativeBuffer.from(a);
    for (const encoding of encodings) for (const start of [undefined, -3, 0, 1, 1.9, 8, 10, NaN])
      for (const end of [undefined, -1, 0, 1, 3.8, 8, 10, NaN])
        expect(outcome(() => a.toString(encoding, start, end)))
          .toEqual(outcome(() => b.toString(encoding as any, start, end)));
    for (const value of [a, new Uint16Array([0x1234, 0xd800]), new DataView(new ArrayBuffer(3)),
      new ArrayBuffer(3), new SharedArrayBuffer(3), {}, null])
      for (const encoding of [...encodings, 'unknown', undefined, 1])
        expect(outcome(() => Buffer.stringLength(value, encoding)))
          .toEqual(outcome(() => NativeBuffer.stringLength(value as any, encoding as any)));
    for (const string of [...strings, {}, null, 1])
      expect(outcome(() => isLatin1(string))).toEqual(outcome(() => nativeIsLatin1(string as any)));
  });
  it('fills encoded patterns, raw view bytes and overlapping ranges with actual storage', () => {
    for (const value of [...strings, undefined, null, true, false, {}, 0x123, -1, 1n, Symbol('fill'),
      new Uint8Array(), new Uint8Array([1, 2]), new Uint16Array([0x1234, 0xabcd]), new DataView(new ArrayBuffer(2))])
      for (const encoding of [undefined, 'utf8', 'hex', 'base64', 'utf16le', 'latin1']) {
        const a = Buffer.alloc(7, 0x55), b = NativeBuffer.alloc(7, 0x55);
        expect(outcome(() => a.fill(value, 1, 6, encoding)), `${String(value)} ${encoding}`)
          .toEqual(outcome(() => b.fill(value, 1, 6, encoding as any)));
        expect([...a]).toEqual([...b]);
      }
    const a = Buffer.from([1, 2, 3, 4, 5, 6]), b = NativeBuffer.from(a);
    a.fill(new Uint8Array(a.buffer, a.byteOffset + 1, 3), 0, 6);
    b.fill(new Uint8Array(b.buffer, b.byteOffset + 1, 3), 0, 6);
    expect([...a]).toEqual([...b]);
    for (const size of [-1, 1.9, NaN, '3', null, undefined, 0, 3])
      expect(outcome(() => Buffer.alloc(size, 'é', 'utf8')))
        .toEqual(outcome(() => NativeBuffer.alloc(size as any, 'é', 'utf8')));
  });
  it('searches strings, byte and numeric needles with relative offsets and exclusive ends', () => {
    const input = [0x61, 0, 0x61, 0, 0x62, 0, 0x61, 0, 0xff];
    const a = Buffer.from(input), b = NativeBuffer.from(input);
    for (const encoding of encodings) for (const needle of ['', 'a', 'aa', 'b', 'é', '6100', 0x161,
      new Uint8Array(), new Uint8Array([0x61]), new Uint8Array([0x61, 0, 0xff])])
      for (const offset of [undefined, -12, -2, 0, 1, 2, 7, 12, NaN])
        for (const end of [0, 1, 3, 6, 9, 12, -1]) for (const method of ['indexOf', 'lastIndexOf', 'includes'])
          expect(outcome(() => a[method](needle, offset, end, encoding)), `${method} ${encoding} ${String(needle)} ${offset} ${end}`)
            .toEqual(outcome(() => (b as any)[method](needle, offset, end, encoding)));
  });
  it('uses branded storage behind helpers and recreates assignment descriptors and aliases', () => {
    const a = Buffer.from([0xff, 0x61]), b = NativeBuffer.from(a);
    Object.defineProperties(a, { buffer: { get() { throw Error('shadow buffer'); } },
      byteOffset: { get() { throw Error('shadow offset'); } } });
    for (const name of ['asciiSlice', 'latin1Slice', 'utf8Slice', 'hexSlice', 'base64Slice', 'base64urlSlice', 'ucs2Slice'])
      expect(a[name](0, 2)).toBe((b as any)[name](0, 2));
    for (const name of ['write', 'fill', 'toString', 'asciiSlice', 'utf8Write', 'indexOf', 'lastIndexOf']) {
      const actual = Object.getOwnPropertyDescriptor(Buffer.prototype, name)!;
      const expected = Object.getOwnPropertyDescriptor(NativeBuffer.prototype, name)!;
      expect({ ...actual, value: undefined }).toEqual({ ...expected, value: undefined });
      expect(actual.value.length).toBe(expected.value.length);
      expect(actual.value.name).toBe(expected.value.name);
    }
    expect(Buffer.prototype.toLocaleString).toBe(Buffer.prototype.toString);
  });
  it('keeps allocation and fill private owners independent of mutable public allocators', () => {
    const { Buffer: B } = require('./fixtures/node-buffer-codecs.cjs').create();
    const allocate = B.allocUnsafeSlow;
    B.allocUnsafeSlow = () => { throw Error('public allocator replaced'); };
    try {
      for (const encoding of encodings) for (const pattern of ['éab', '6162'])
        expect(outcome(() => B.alloc(80, pattern, encoding)))
          .toEqual(outcome(() => NativeBuffer.alloc(80, pattern, encoding as any)));
    } finally { B.allocUnsafeSlow = allocate; }
  });
  it('preserves private slice/write brands, string validation and native binding diagnostics', () => {
    for (const receiver of [{}, 1, 'x', null, new Uint16Array(4), new DataView(new ArrayBuffer(4))])
      for (const name of ['asciiSlice', 'utf8Slice', 'hexSlice', 'ucs2Slice', 'base64Slice'])
        expect(outcome(() => Reflect.apply(Buffer.prototype[name], receiver, [0, 2])))
          .toEqual(outcome(() => Reflect.apply((NativeBuffer.prototype as any)[name], receiver, [0, 2])));
    for (const name of ['asciiWrite', 'latin1Write', 'utf8Write', 'hexWrite', 'ucs2Write', 'base64Write'])
      for (const value of [null, 1, {}, undefined, 'abc']) for (const offset of [0, 6]) {
        const a = Buffer.alloc(4), b = NativeBuffer.alloc(4);
        expect(outcome(() => a[name](value, offset, 1)))
          .toEqual(outcome(() => (b as any)[name](value, offset, 1)));
        expect([...a]).toEqual([...b]);
      }
  });
});
