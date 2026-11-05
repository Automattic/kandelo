import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { constants } from 'node:os';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import { describe, expect, it } from 'vitest';

const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const domSource = readFileSync(new URL('../../third_party/node-core/upstream/domexception.js', import.meta.url), 'utf8');
const webidlSource = readFileSync(new URL('../../third_party/node-core/upstream/webidl.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const factories = Function(`${bundle};return { random:_createNodeCryptoRandomSync, values:_createNodeValuesPlatform, primordials:_createNodePrimordials };`)();
function subject() {
  const dom = Function('primordials', 'privateSymbols', 'perIsolateSymbols',
    `const exports={};${domSource};return exports;`)(factories.primordials(),
    { transfer_mode_private_symbol: Symbol('mode') },
    { messaging_clone_symbol: Symbol('clone'), messaging_deserialize_symbol: Symbol('deserialize') });
  const values = factories.values({ process, Buffer, util, inspection: util, os: {},
    signals: constants.signals, getDOMException: () => dom.DOMException });
  const sharedGrowable = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'growable')!.get!;
  const webidl = Function('primordials', 'require', 'internalBinding',
    `const module={exports:{}};${webidlSource};return module.exports;`)(factories.primordials(), (name: string) => {
      if (name === 'internal/util') return values.util;
      if (name === 'internal/util/types') return util.types;
      throw Error('Unsupported test WebIDL dependency: ' + name);
    }, (name: string) => {
      if (name !== 'util') throw Error('Unsupported test WebIDL binding: ' + name);
      return { getSharedArrayBufferGrowable(this: unknown) { return Reflect.apply(sharedGrowable, this, []); } };
    });
  const calls: number[] = [];
  const api = factories.random({ values, types: util.types, dom, webidl,
    kMaxLength: 2 ** 31 - 1, fillBytes(bytes: Uint8Array) { calls.push(bytes.byteLength); bytes.fill(0xa5); } });
  return { ...api, calls };
}
function failure(fn: () => unknown) {
  try { fn(); return undefined; }
  catch (e: any) { return { name: e.name, code: e.code, message: e.message, quota: e.quota, requested: e.requested }; }
}

describe.skipIf(process.versions.node !== target.version)('pinned synchronous random byte contracts', () => {
  it('matches valid integer getRandomValues brands, quota units and original identity', () => {
    const api = subject();
    for (const C of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array]) {
      for (const size of [0, 1, 65536 / C.BYTES_PER_ELEMENT]) {
        const value = new C(size);
        expect(api.getRandomValues(value)).toBe(value);
        expect(crypto.getRandomValues(new C(size))).toBeInstanceOf(C);
        if (size > 0) expect(new Uint8Array(value.buffer).every(v => v === 0xa5)).toBe(true);
      }
    }
  });

  it('matches mismatched brands, forged metadata and actual quota error objects', () => {
    const api = subject();
    const Float16 = (globalThis as any).Float16Array;
    for (const value of [null, undefined, {}, [], 'abc', new ArrayBuffer(3), new DataView(new ArrayBuffer(4)),
      new Float32Array(1), new Float64Array(1), { buffer: new ArrayBuffer(2), byteLength: 2 },
      new Uint8Array(65537), new Uint16Array(32769), new BigInt64Array(8193),
      ...(typeof Float16 === 'function' ? [new Float16(1)] : []),
      new Uint8Array(new SharedArrayBuffer(4)), new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }))]) {
      expect(failure(() => api.getRandomValues(value))).toEqual(failure(() => crypto.getRandomValues(value as any)));
    }
    expect(api.calls).toHaveLength(0);
    expect(failure(() => api.getRandomValues())).toEqual(failure(() => crypto.getRandomValues(undefined as any)));
  });

  it('uses intrinsic byte length and brands across realms and checks backing policy', () => {
    const api = subject();
    const foreign = runInNewContext('new Uint16Array(8)');
    for (const value of [foreign]) {
      Object.defineProperty(value, 'byteLength', { get() { throw Error('public length getter'); } });
      expect(api.getRandomValues(value)).toBe(value);
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.length * value.BYTES_PER_ELEMENT);
      expect(bytes.every(v => v === 0xa5)).toBe(true);
    }
    const shared = new Uint8Array(new SharedArrayBuffer(16), 4, 8);
    expect(failure(() => api.getRandomValues(shared))).toEqual(failure(() => crypto.getRandomValues(shared)));
  });

  it('matches raw/view fill units, fractional bounds and zero-length calls', () => {
    const constructors = [(buffer: ArrayBufferLike) => buffer,
      (buffer: ArrayBufferLike) => new DataView(buffer, 2, 12),
      (buffer: ArrayBufferLike) => new Uint8Array(buffer, 2, 12),
      (buffer: ArrayBufferLike) => new Uint16Array(buffer, 2, 6),
      (buffer: ArrayBufferLike) => new Uint32Array(buffer, 4, 3),
      (buffer: ArrayBufferLike) => new BigUint64Array(buffer, 0, 2)];
    for (const make of constructors) for (const shared of [false, true]) {
      for (const [offset, size] of [[0, 0], [1, 1], [0.75, 0.75], [2, 0]]) {
        const buffer = shared ? new SharedArrayBuffer(16) : new ArrayBuffer(16), value = make(buffer), api = subject();
        const expectedBuffer = shared ? new SharedArrayBuffer(16) : new ArrayBuffer(16), expected = make(expectedBuffer);
        const actualFailure = failure(() => { expect(api.randomFillSync(value, offset, size)).toBe(value); });
        const nativeFailure = failure(() => crypto.randomFillSync(expected as any, offset, size));
        expect(actualFailure).toEqual(nativeFailure);
        if (!actualFailure) {
          const unit = (value as any).BYTES_PER_ELEMENT ?? 1;
          const base = (value as any).byteOffset ?? 0;
          const start = base + (offset * unit >>> 0), length = size * unit >>> 0;
          expect([...new Uint8Array(buffer)]).toEqual(Array.from({ length: 16 }, (_, i) => i >= start && i < start + length ? 0xa5 : 0));
        }
      }
    }
  });

  it('matches fill validation before accessing entropy and handles detached inputs as the pin does', () => {
    const api = subject();
    for (const value of [{}, 'abc', null, undefined]) expect(failure(() => api.randomFillSync(value)))
      .toEqual(failure(() => crypto.randomFillSync(value as any)));
    for (const offset of [-1, NaN, Infinity, '1', null, {}]) expect(failure(() => api.randomFillSync(new Uint8Array(4), offset)))
      .toEqual(failure(() => crypto.randomFillSync(new Uint8Array(4), offset as any)));
    for (const size of [-1, NaN, Infinity, '1', null, {}, 5]) expect(failure(() => api.randomFillSync(new Uint8Array(4), 0, size)))
      .toEqual(failure(() => crypto.randomFillSync(new Uint8Array(4), 0, size as any)));
    expect(api.calls).toHaveLength(0);
    const buffer = new ArrayBuffer(4), view = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] });
    expect(failure(() => api.randomFillSync(view))).toEqual(failure(() => crypto.randomFillSync(view)));
    expect(failure(() => api.getRandomValues(view))).toEqual(failure(() => crypto.getRandomValues(view)));
  });

  it('forwards the exact shared span to the provider and preserves provider errors', () => {
    const a = bootstrap.indexOf('function _fillRandomBytes(');
    const b = bootstrap.indexOf('    const _nodeCryptoRandomPrimordials = ', a);
    if (a < 0 || b < 0) throw Error('Missing entropy owner source');
    const calls: Uint8Array[] = [];
    let error: any;
    const native = { randomFillBytes(bytes: Uint8Array) {
      calls.push(bytes);
      if (error) return error;
      bytes.fill(0x6b);
    } };
    const fill = Function('_nodeNative', '_nodeCryptoRandomPrimordials',
      bootstrap.slice(a, b) + ';return _fillRandomBytes;')(native, factories.primordials());
    const bytes = new Uint8Array(new SharedArrayBuffer(100008));
    expect(fill(bytes, 4, 100000)).toBe(bytes);
    expect([...bytes.subarray(0, 4), ...bytes.subarray(100004)]).toEqual(Array(8).fill(0));
    expect(bytes.subarray(4, 100004).every(v => v === 0x6b)).toBe(true);
    expect(calls[0].buffer).toBe(bytes.buffer);
    expect(calls[0].byteOffset).toBe(4);
    expect(calls[0].byteLength).toBe(100000);
    error = { message: 'provider failure', code: 'ERR_OSSL_RAND_TEST', reason: 'test', opensslErrorStack: ['owned'] };
    expect(() => fill(bytes, 0, 1)).toThrow('provider failure');
    try { fill(bytes, 0, 1); } catch (failure: any) {
      expect(failure).toBeInstanceOf(Error);
      expect(failure.code).toBe(error.code);
      expect(failure.reason).toBe(error.reason);
      expect(failure.opensslErrorStack).toEqual(error.opensslErrorStack);
    }
  });
});
