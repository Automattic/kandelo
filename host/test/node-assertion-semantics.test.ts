import { readFileSync } from 'node:fs';
import nativeAssert from 'node:assert';
import { isDeepStrictEqual, types } from 'node:util';
import { runInNewContext } from 'node:vm';
import { inspect, format } from 'node:util';
import { describe, expect, it } from 'vitest';

const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
// The actual bundled algorithms, with the native oracle supplying only the
// engine-boundary brands. The guest fixture covers the SpiderMonkey binding.
const core = Function(`${bundle}; return _createNodeCore;`)()({
  Buffer, URL, inspect, format, isPromise: types.isPromise,
  isNativeError: types.isNativeError, isProxy: types.isProxy,
});
const assert = core.assert;
const compare = core.comparisons.isDeepStrictEqual;
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function outcome(fn: () => unknown): { ok?: boolean; name?: string; code?: string; operator?: string } {
  try { fn(); return { ok: true }; }
  catch (error: any) { return { name: error?.name, code: error?.code, operator: error?.operator }; }
}
const symbols = [Symbol('a'), Symbol.for('b')];
function values(): any[] {
  const cycle: any = { n: 1 }; cycle.self = cycle;
  const cycle2: any = { n: 2 }; cycle2.self = cycle2;
  return [undefined, null, false, true, 0, -0, NaN, 1, '1', 1n, symbols[0], symbols[1],
    {}, { a: undefined }, { b: undefined }, { a: 1 }, { a: '1' },
    { [symbols[0]]: 1 }, { [symbols[1]]: 1 }, [], [undefined], Array(1), [0], [-0],
    new Date(0), new Date(1), new Date(NaN), /a/g, /a/i, Object.assign(/a/g, { lastIndex: 1 }),
    new Map(), new Map([['a', 1]]), new Map([['a', 2]]), new Map([[{ k: 1 }, new Set([1])]]),
    new Set([1, 2]), new Set([2, 1]), new Set([1, '2']), new Set([{ k: 1 }]),
    new Uint8Array([1]), new Uint8Array([2]), new Int8Array([1]), new Float32Array([NaN]),
    new ArrayBuffer(1), new ArrayBuffer(2), new DataView(new ArrayBuffer(1)),
    new Number(0), new Number(-0), new Number(NaN), new String('a'), new Boolean(false),
    Object(1n), Object(symbols[0]), new Error('a'), new Error('b'), new TypeError('a'),
    new Error('a', { cause: 1 }), new Error('a', { cause: 2 }),
    new WeakMap(), new WeakMap(), new WeakSet(), new WeakSet(), Promise.resolve(), Promise.resolve(),
    Object.create(Promise.prototype), { [Symbol.toStringTag]: 'Promise' },
    Object.create(null), Object.create({ marker: true }), cycle, cycle2,
    new URL('https://example.org/a'), new URL('https://example.org/b'),
  ];
}

// Expectations come from the exact API target. The host/build toolchain is
// independent: run this suite under the pinned reference, as documented.
describe.skipIf(process.versions.node !== target.version)('pinned Node assertion semantics', () => {
  it('rejects every adversarial harness false positive', () => {
    expect(outcome(() => assert.throws(() => { throw Error('actual'); }, /expected/)).code).toBe('ERR_ASSERTION');
    expect(outcome(() => assert.strictEqual(0, -0)).code).toBe('ERR_ASSERTION');
    expect(compare(new Map([['x', 1]]), new Map([['x', 2]]))).toBe(false);
    expect(compare({ a: undefined }, { b: undefined })).toBe(false);
  });

  it('matches strict, loose and partial upstream comparisons across value pairs', () => {
    const all = values();
    for (let i = 0; i < all.length; i++) for (let j = 0; j < all.length; j++) {
      const [a, b] = [all[i], all[j]];
      expect(compare(a, b), `strict pair ${i},${j}`).toBe(isDeepStrictEqual(a, b));
      for (const method of ['deepEqual', 'deepStrictEqual', 'partialDeepStrictEqual', 'notDeepEqual', 'notDeepStrictEqual']) {
        expect(outcome(() => assert[method](a, b)), `${method} ${i},${j}`)
          .toEqual(outcome(() => (nativeAssert as any)[method](a, b)));
      }
    }
  }, 30_000);

  it('compares cyclic collections, missing keys, error causes and byte ranges', () => {
    const a: any = new Map(), b: any = new Map(); a.set(a, new Set([a])); b.set(b, new Set([b]));
    const pairs = [[a, b], [a, new Map([[b, new Set()]])],
      [new AggregateError([Error('a')]), new AggregateError([Error('b')])],
      [new Uint8Array([0, 1, 2]).subarray(1, 2), new Uint8Array([1])],
      [new DataView(new Uint8Array([0, 1, 2]).buffer, 1, 1), new DataView(new Uint8Array([1]).buffer)],
      [Object.create(null, { a: { enumerable: true, value: undefined } }), Object.create(null)],
    ];
    for (const [a, b] of pairs) expect(compare(a, b)).toBe(isDeepStrictEqual(a, b));
    const foreign = runInNewContext('({ map: new Map([[1, 2]]), promise: Promise.resolve(1), error: Error("x"), date: new Date(0) })');
    expect(core.types.isPromise(foreign.promise)).toBe(true);
    expect(core.types.isNativeError(foreign.error)).toBe(true);
    for (const [a, b] of [[foreign.map, new Map([[1, 2]])], [foreign.date, new Date(0)],
      [foreign.promise, Promise.resolve(1)]]) {
      expect(compare(a, b, true)).toBe((isDeepStrictEqual as any)(a, b, true));
    }
  });

  it('uses genuine brands and does not observe promise properties', () => {
    for (const name of ['Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer',
      'SharedArrayBuffer', 'Number', 'Boolean', 'String', 'BigInt', 'Symbol', 'Promise', 'Error']) {
      const fake = { [Symbol.toStringTag]: name };
      const method = 'is' + ({ Number: 'NumberObject', Boolean: 'BooleanObject', String: 'StringObject',
        BigInt: 'BigIntObject', Symbol: 'SymbolObject', Error: 'NativeError' }[name] || name);
      expect(core.types[method](fake), name).toBe(false);
      const ctor = (globalThis as any)[name];
      if (ctor) expect(core.types[method](Object.create(ctor.prototype)), name).toBe(false);
    }
    const promise = Promise.resolve(1);
    Object.defineProperties(promise, { then: { get() { throw Error('observed then'); } },
      constructor: { get() { throw Error('observed constructor'); } } });
    expect(core.types.isPromise(promise)).toBe(true);
    expect(core.types.isPromise(new Proxy(promise, {}))).toBe(false);
    expect(core.types.isProxy(new Proxy({}, {}))).toBe(true);
  });

  it('matches thrown error constructors, predicates, patterns and object fields', () => {
    for (const actual of [Error('actual'), TypeError('actual'), Object.assign(Error('actual'), { code: 'X', cause: { a: 1 } }),
      'actual', undefined, null, 42]) {
      for (const expected of [undefined, null, /actual/, /other/, Error, TypeError, RangeError,
        (error: unknown) => error === actual, () => false, () => 1, {}, { message: /actual/ },
        { code: 'X', cause: { a: 1 } }, { code: 'Y' }, Error('actual'), 'custom', 1]) {
        for (const method of ['throws', 'doesNotThrow']) {
          expect(outcome(() => assert[method](() => { throw actual; }, expected)), method)
            .toEqual(outcome(() => (nativeAssert as any)[method](() => { throw actual; }, expected)));
        }
      }
    }
    const same = Error('forward');
    expect(() => assert.doesNotThrow(() => { throw same; }, /different/)).toThrow(same);
  });

  it('awaits rejection outcomes and rejects invalid promise inputs', async () => {
    const asyncOutcome = async (fn: () => Promise<unknown>) => { try { await fn(); return { ok: true }; }
      catch (error: any) { return { name: error.name, code: error.code, operator: error.operator }; } };
    for (const method of ['rejects', 'doesNotReject']) {
      for (const fn of [() => Promise.reject(Error('actual')), () => Promise.resolve(1),
        () => { throw TypeError('sync'); }, () => 1, () => ({ then(resolve: any, reject: any) { reject(Error('actual')); }, catch() {} })]) {
        for (const matcher of [undefined, /actual/, /different/, TypeError, { message: /actual/ }]) {
          expect(await asyncOutcome(() => assert[method](fn, matcher)))
            .toEqual(await asyncOutcome(() => (nativeAssert as any)[method](fn, matcher)));
        }
      }
    }
  });

  it('keeps strict aliases distinct and honors Assert instance options', () => {
    expect(assert.strict).not.toBe(assert);
    expect(assert.strict.strict).toBe(assert.strict);
    expect(assert.strict.equal).toBe(assert.strictEqual);
    expect(outcome(() => assert.equal(1, '1'))).toEqual({ ok: true });
    expect(outcome(() => assert.strict.equal(1, '1'))).toEqual(outcome(() => nativeAssert.strict.equal(1, '1')));
    for (const options of [undefined, { strict: false }, { skipPrototype: true }, { diff: 'invalid' }]) {
      expect(outcome(() => { const a = new assert.Assert(options); a.deepEqual({ a: 1 }, { a: '1' }); }))
        .toEqual(outcome(() => { const a = new (nativeAssert as any).Assert(options); a.deepEqual({ a: 1 }, { a: '1' }); }));
    }
  });

  it('preserves failures, custom error identity and lazy message evaluation', () => {
    expect(outcome(() => assert(false)).code).toBe('ERR_ASSERTION');
    expect(outcome(() => assert())).toEqual(outcome(() => (nativeAssert as any)()));
    let calls = 0;
    const message = (a: unknown, b: unknown) => { calls++; return `${a}:${b}`; };
    assert.strictEqual(1, 1, message);
    expect(calls).toBe(0);
    expect(() => assert.strictEqual(1, 2, message)).toThrow('1:2');
    expect(calls).toBe(1);
    const error = Error('custom');
    try { assert.strictEqual(1, 2, error); throw Error('missing failure'); }
    catch (actual) { expect(actual).toBe(error); }
    for (const method of ['strictEqual', 'notStrictEqual', 'deepEqual', 'match', 'doesNotMatch', 'ifError', 'fail']) {
      const args: any[] = method === 'match' || method === 'doesNotMatch' ? [1, /a/] : [];
      expect(outcome(() => assert[method](...args))).toEqual(outcome(() => (nativeAssert as any)[method](...args)));
    }
  });
});
