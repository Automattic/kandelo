import { Buffer as NativeBuffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
// The exact-reference runner supplies native backing allocation/alignment and
// detach-key dependencies. This is actual shared public Buffer source, not a
// guest/native allocator or four-host conformance result.
const require = createRequire(import.meta.url);
const Buffer = process.versions.node === target.version ?
  require('./fixtures/node-buffer-pool.cjs').create().Buffer : undefined;

function outcome(fn: () => any) {
  try {
    const value = fn();
    return { value: ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value };
  } catch (error: any) { return { name: error.name, code: error.code, message: error.message }; }
}

describe.skipIf(process.versions.node !== target.version)('pinned shared Buffer byte contracts', () => {
  it('copies Buffer and typed-array elements while raw backing-store overloads share', () => {
    const input = new Uint8Array([1, 2, 3]);
    const copy = Buffer.from(input); input[0] = 9;
    expect([...copy]).toEqual([1, 2, 3]);
    expect(copy.buffer).not.toBe(input.buffer);
    const buffer = Buffer.from(copy); copy[1] = 8;
    expect([...buffer]).toEqual([1, 2, 3]);
    const shared = Buffer.from(input.buffer, 1, 2);
    input[1] = 7; expect(shared[0]).toBe(7);
    for (const value of [new Uint16Array([0x1234, 0x1ff]), new Float64Array([1.8, -1, NaN]),
      new DataView(new ArrayBuffer(4)), runInNewContext('new Uint16Array([257, 258])')]) {
      expect(outcome(() => Buffer.from(value))).toEqual(outcome(() => NativeBuffer.from(value as any)));
    }
    const foreign = runInNewContext('new ArrayBuffer(4)');
    expect(Buffer.from(foreign).buffer).toBe(foreign);
  });

  it('uses target object, valueOf, primitive and invalid-input dispatch', () => {
    for (const value of [null, undefined, 1, {}, [], [1, 257, -1], { length: 2, 0: 3, 1: 4 },
      { length: '2', 0: 1 }, { type: 'Buffer', data: [4, 5] },
      { valueOf: () => [6, 7] }, { valueOf: () => 'abc' },
      { [Symbol.toPrimitive]: () => 'abc' }, { [Symbol.toPrimitive]: () => 1 }]) {
      expect(outcome(() => Buffer.from(value))).toEqual(outcome(() => NativeBuffer.from(value as any)));
    }
    for (const offset of [undefined, null, -1, 1.5, NaN, 5, '2', Symbol('offset')]) {
      for (const length of [undefined, 0, -1, 2, 8, NaN, '2']) {
        expect(outcome(() => Buffer.from(new ArrayBuffer(4), offset, length)))
          .toEqual(outcome(() => NativeBuffer.from(new ArrayBuffer(4), offset as any, length as any)));
      }
    }
  });

  it('copies raw typed-view bytes with copyBytesFrom and preserves of semantics', () => {
    const typed = new Uint16Array([0x1234, 0x5678, 0x9abc]);
    for (const offset of [undefined, 0, 1, 3, 4, -1, 1.5]) {
      for (const length of [undefined, 0, 1, 9, -1]) {
        expect(outcome(() => Buffer.copyBytesFrom(typed, offset, length)))
          .toEqual(outcome(() => NativeBuffer.copyBytesFrom(typed, offset, length)));
      }
    }
    const copied = Buffer.copyBytesFrom(typed); typed[0] = 0;
    expect(copied[0]).not.toBe(0);
    expect([...Buffer.of(1, 257, -1)]).toEqual([...NativeBuffer.of(1, 257, -1)]);
    expect(Object.hasOwn(Buffer.of, 'prototype')).toBe(false);
    expect(outcome(() => Buffer.copyBytesFrom(new DataView(new ArrayBuffer(4)))))
      .toEqual(outcome(() => NativeBuffer.copyBytesFrom(new DataView(new ArrayBuffer(4)) as any)));
  });

  it('truncates concat and validates the complete list before copying', () => {
    const list = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    for (const length of [undefined, 0, 1, 3, 4, 7, -1, 1.5, '3', null]) {
      expect(outcome(() => Buffer.concat(list, length))).toEqual(outcome(() => NativeBuffer.concat(list, length as any)));
    }
    for (const list of [null, {}, [new Uint8Array([1]), {}], [new Uint16Array([1])], []]) {
      expect(outcome(() => Buffer.concat(list, 0))).toEqual(outcome(() => NativeBuffer.concat(list as any, 0)));
    }
  });

  it('copies overlaps and typed-view byte spans with target bounds/coercion', () => {
    for (const targetStart of [undefined, 0, 1, 4, 8, -1, 1.5, '2', NaN]) {
      for (const sourceStart of [undefined, 0, 1, 4, -1, '1']) {
        const actual = Buffer.from([1, 2, 3, 4]), expected = NativeBuffer.from([1, 2, 3, 4]);
        expect(outcome(() => actual.copy(actual, targetStart, sourceStart)))
          .toEqual(outcome(() => expected.copy(expected, targetStart as any, sourceStart as any)));
        expect([...actual]).toEqual([...expected]);
      }
    }
    for (const target of [new Uint16Array(2), new DataView(new ArrayBuffer(4))]) {
      const expected = new Uint8Array(4);
      expect(Buffer.from([1, 2, 3, 4]).copy(target)).toBe(4);
      NativeBuffer.from([1, 2, 3, 4]).copy(expected);
      expect([...new Uint8Array(target.buffer)]).toEqual([...expected]);
    }
  });

  it('compares byte spans and rejects non-Uint8 views in public comparisons', () => {
    for (const input of [new Uint8Array(), new Uint8Array([1, 2]), new Uint8Array([1, 3]),
      new Uint8ClampedArray([1, 2]), new Uint16Array([1, 2]), new DataView(new ArrayBuffer(2)), {}]) {
      expect(outcome(() => Buffer.compare(Buffer.from([1, 2]), input)))
        .toEqual(outcome(() => NativeBuffer.compare(NativeBuffer.from([1, 2]), input as any)));
      expect(outcome(() => Buffer.from([1, 2]).equals(input)))
        .toEqual(outcome(() => NativeBuffer.from([1, 2]).equals(input as any)));
    }
    for (const offsets of [[0, 1, 0, 1], [0, 4, 1, 4], [4, 4, 4, 4], [-1, 3, 0, 2], [0, 8, 0, 2]]) {
      expect(outcome(() => Buffer.from([1, 2, 3, 4]).compare(new Uint8Array([1, 2, 3, 5]), ...offsets)))
        .toEqual(outcome(() => NativeBuffer.from([1, 2, 3, 4]).compare(new Uint8Array([1, 2, 3, 5]), ...offsets)));
    }
  });

  it('keeps private copy and comparison independent of typed-array species', () => {
    const actual = Buffer.from([1, 2, 3, 4]), other = Buffer.from([1, 2, 3, 5]);
    const expected = NativeBuffer.from([1, 2, 3, 4]), nativeOther = NativeBuffer.from([1, 2, 3, 5]);
    const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.species);
    let actualCopy, expectedCopy, actualCompare, expectedCompare;
    try {
      Object.defineProperty(Uint8Array, Symbol.species, { configurable: true,
        get() { throw Error('private byte binding observed species'); } });
      actualCompare = actual.compare(other, 1, 4, 1, 4);
      expectedCompare = expected.compare(nativeOther, 1, 4, 1, 4);
      actualCopy = actual.copy(other, 1, 1, 3);
      expectedCopy = expected.copy(nativeOther, 1, 1, 3);
    } finally {
      if (descriptor) Object.defineProperty(Uint8Array, Symbol.species, descriptor);
      else Reflect.deleteProperty(Uint8Array, Symbol.species);
    }
    expect(actualCompare).toBe(expectedCompare);
    expect(actualCopy).toBe(expectedCopy);
    expect([...other]).toEqual([...nativeOther]);
  });

  it('swaps small and large actual byte storage and retains descriptors', () => {
    for (const method of ['swap16', 'swap32', 'swap64']) {
      for (const length of [0, 1, 2, 8, 32, 40, 48, 64]) {
        const actual = Buffer.from(Array.from({ length }, (_, i) => i));
        const expected = NativeBuffer.from(actual);
        expect(outcome(() => actual[method]())).toEqual(outcome(() => (expected as any)[method]()));
        expect([...actual]).toEqual([...expected]);
      }
      expect(Object.getOwnPropertyDescriptor(Buffer.prototype, method)?.enumerable).toBe(true);
    }
    const value = Buffer.from([1, 2]);
    expect(value.parent).toBe(value.buffer); expect(value.offset).toBe(value.byteOffset);
    for (const method of ['from', 'copyBytesFrom', 'compare', 'concat', 'isEncoding']) {
      expect(Object.getOwnPropertyDescriptor(Buffer, method)?.enumerable).toBe(true);
      expect(Buffer[method].length).toBe((NativeBuffer as any)[method].length);
    }
    for (const encoding of ['utf8', 'BASE64URL', '', null, undefined, 1, { toString: () => 'utf8' }]) {
      expect(Buffer.isEncoding(encoding)).toBe(NativeBuffer.isEncoding(encoding as any));
    }
  });
});
