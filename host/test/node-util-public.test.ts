import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import * as nativeUtil from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const factories = Function(`${bundle}; return { values: _createNodeValuesPlatform, publicUtil: _createNodePublicUtil, uv: _createNodeUvPlatform };`)();

// These controls exercise the actual shared factories and bootstrap selection.
// Native Node supplies only the engine operation/brands and signal-table input;
// they do not validate SpiderMonkey hooks or guest signal constants.
function implementation() {
  const warnings: unknown[][] = [], handled: unknown[] = [];
  const util = { types: nativeUtil.types, getSystemErrorName: nativeUtil.getSystemErrorName };
  const uv = factories.uv({ native: { getUvErrorData: () => [...nativeUtil.getSystemErrorMap()]
    .map(([number, [name, message]]) => [number, name, message]) } });
  const values = factories.values({
    process: { platform: 'kandelo', emitWarning: (...args: unknown[]) => warnings.push(args) },
    Buffer, util, uv, inspection: nativeUtil, os: {}, signals: constants.signals,
    getDOMException: () => DOMException,
  });
  const native = { markPromiseAsHandled(value: Promise<unknown>) {
    handled.push(value);
    (nativeUtil as any).markPromiseAsHandled(value);
  } };
  const start = bootstrap.indexOf('util.promisify = _nodeValues.util.promisify;');
  // Stop before the next owner; Buffer construction is not part of util.
  const end = bootstrap.indexOf('_nodeBufferConstructor.initialize(', start);
  if (start < 0 || end < start) throw Error('Public util bootstrap selection missing');
  Function('_nodeValues', '_nodeNative', 'util', '_createNodePublicUtil', bootstrap.slice(start, end))(
    values, native, util, factories.publicUtil);
  return { util: util as any, warnings, handled, values };
}
function outcome(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (error: any) { return { name: error.name, code: error.code, message: error.message }; }
}

// The Node 24 build toolchain is not the Node 26 native differential oracle.
// Keep its skip visible; the implementation ledger records the pinned run.
describe.skipIf(process.versions.node !== target.version)('pinned public util wrappers', () => {
  it('uses the exact pinned native reference', () => {
    expect(process.versions.node).toBe(target.version);
  });

  it('returns complete independent system error maps and target public validation', () => {
    const { util } = implementation();
    expect([...util.getSystemErrorMap()]).toEqual([...nativeUtil.getSystemErrorMap()]);
    for (const [number] of nativeUtil.getSystemErrorMap()) {
      expect(util.getSystemErrorName(number)).toBe(nativeUtil.getSystemErrorName(number));
      expect(util.getSystemErrorMessage(number)).toBe(nativeUtil.getSystemErrorMessage(number));
    }
    const first = util.getSystemErrorMap();
    const number = first.keys().next().value;
    first.get(number)[0] = 'changed'; first.clear();
    expect([...util.getSystemErrorMap()]).toEqual([...nativeUtil.getSystemErrorMap()]);
    for (const number of [-1, -13, -3008, -999999, 0, -0, 1, -1.5, NaN,
      -Infinity, undefined, null, '1', Symbol('number'), {}]) {
      expect(outcome(() => util.getSystemErrorName(number))).toEqual(outcome(() => nativeUtil.getSystemErrorName(number as any)));
      expect(outcome(() => util.getSystemErrorMessage(number))).toEqual(outcome(() => nativeUtil.getSystemErrorMessage(number as any)));
    }
  });

  it('does not consult mutable public collection methods when creating an error map', () => {
    const { util } = implementation();
    const mapSet = Map.prototype.set, arrayIterator = Array.prototype[Symbol.iterator];
    let actual: Map<number, string[]>;
    try {
      Map.prototype.set = () => { throw Error('Public Map.set must not be called'); };
      Array.prototype[Symbol.iterator] = () => { throw Error('Public Array iterator must not be called'); };
      actual = util.getSystemErrorMap();
    } finally {
      Map.prototype.set = mapSet; Array.prototype[Symbol.iterator] = arrayIterator;
    }
    expect([...actual!]).toEqual([...nativeUtil.getSystemErrorMap()]);
  });

  it('owns MIME parsing, parameter mutation, iteration and serialization', () => {
    const { util } = implementation();
    function use(MIMEType: any) {
      const mime = new MIMEType(' Text/PLAIN ; Charset="UTF-8";x=one;x=two;empty="" ');
      const initial = [mime.type, mime.subtype, mime.essence, [...mime.params], `${mime}`];
      mime.type = 'application'; mime.subtype = 'example+json';
      mime.params.set('CHARSET', 'windows-1252');
      mime.params.set('quoted', 'space and "quote"');
      mime.params.delete('X');
      return [initial, [...mime.params.keys()], [...mime.params.values()],
        mime.params.get('Charset'), mime.params.has('QUOTED'), `${mime}`, JSON.stringify(mime),
        `${MIMEType.parse('APPLICATION/JSON;a=1')}`, MIMEType.parse('invalid')];
    }
    expect(use(util.MIMEType)).toEqual(use(nativeUtil.MIMEType));
    const actualParams = new util.MIMEParams();
    const nativeParams = new nativeUtil.MIMEParams();
    for (const params of [actualParams, nativeParams]) params.set('NAME', 'value with space');
    expect([...actualParams]).toEqual([...nativeParams]);
    expect(`${actualParams}`).toBe(`${nativeParams}`);
    expect(JSON.stringify(actualParams)).toBe(JSON.stringify(nativeParams));
    expect(util.MIMEType.prototype.toJSON).toBe(util.MIMEType.prototype.toString);
    expect(util.MIMEParams.prototype[Symbol.iterator]).toBe(util.MIMEParams.prototype.entries);
  });

  it('retains MIME coercion, syntax errors, receiver brands and descriptors', () => {
    const { util } = implementation();
    for (const input of [null, undefined, 1, {}, Symbol('mime'), 'text/plain',
      'text plain', '/plain', 'text/', 'text/\u0000', { toString: () => 'IMAGE/SVG+XML' }]) {
      const invoke = (MIMEType: any) => `${new MIMEType(input)}`;
      expect(outcome(() => invoke(util.MIMEType))).toEqual(outcome(() => invoke(nativeUtil.MIMEType)));
    }
    for (const name of ['MIMEType', 'MIMEParams']) {
      for (const key of Reflect.ownKeys(util[name].prototype)) {
        const actual = Object.getOwnPropertyDescriptor(util[name].prototype, key)!;
        const expected = Object.getOwnPropertyDescriptor((nativeUtil as any)[name].prototype, key)!;
        const shape = (d: PropertyDescriptor) => ({ enumerable: d.enumerable,
          configurable: d.configurable, writable: d.writable,
          value: typeof d.value === 'function' ? [d.value.name, d.value.length] : d.value,
          get: d.get && [d.get.name, d.get.length], set: d.set && [d.set.name, d.set.length] });
        expect(shape(actual)).toEqual(shape(expected));
        if (actual.get) {
          expect(outcome(() => actual.get!.call({}))).toEqual(outcome(() => expected.get!.call({})));
        }
      }
    }
  });

  it('unwraps public deprecate options and preserves call/constructor policy', () => {
    const { util, warnings } = implementation();
    function Original(this: any, a: number, b: number) { this.sum = a + b; return this.sum; }
    for (const options of [undefined, {}, { modifyPrototype: true }, { modifyPrototype: false }]) {
      const actual = util.deprecate(Original, 'old', 'DEP_UTIL_CONTROL', options);
      const expected = (nativeUtil.deprecate as any)(Original, 'old', 'DEP_UTIL_CONTROL', options);
      expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(expected));
      expect(actual.prototype === Original.prototype).toBe(expected.prototype === Original.prototype);
      expect(actual.length).toBe(expected.length);
      expect(actual.name).toBe(expected.name);
      const receiver = { sum: 0 };
      expect(actual.call(receiver, 2, 3)).toBe(5);
      expect(receiver.sum).toBe(5);
      const instance = new actual(4, 5);
      expect(instance.sum).toBe(9);
      expect(instance instanceof Original).toBe(options?.modifyPrototype !== false);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0].slice(0, 3)).toEqual(['old', 'DeprecationWarning', 'DEP_UTIL_CONTROL']);
  });

  it('retains exact public option and code validation errors', () => {
    const { util } = implementation();
    for (const code of [null, 1, Symbol('code'), {}, 'DEP_CONTROL']) {
      for (const options of [null, false, 0, { modifyPrototype: false }]) {
        const invoke = (deprecate: any) => { deprecate(() => {}, 'old', code, options); };
        expect(outcome(() => invoke(util.deprecate))).toEqual(outcome(() => invoke(nativeUtil.deprecate)));
      }
    }
  });

  it('retains _extend object-only and reverse enumerable-key behavior', () => {
    const { util, warnings } = implementation();
    function extend(implementation: any) {
      const reads: string[] = [], symbol = Symbol('ignored');
      const source = Object.create({ inherited: 1 }, {
        a: { enumerable: true, get() { reads.push('a'); return 1; } },
        b: { enumerable: true, get() { reads.push('b'); return 2; } },
        [symbol]: { enumerable: true, value: 3 },
      });
      const target = { retained: true };
      const result = implementation(target, source);
      return { result, same: result === target, reads, symbols: Object.getOwnPropertySymbols(result).length };
    }
    expect(extend(util._extend)).toEqual(extend((nativeUtil as any)._extend));
    for (const value of [null, undefined, false, 1, 'text', () => {}]) {
      const target = {};
      expect(util._extend(target, value)).toBe(target);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0][2]).toBe('DEP0060');
  });

  it('keeps isArray with its actual deprecation wrapper', () => {
    const { util, warnings } = implementation();
    for (const value of [[], new Proxy([], {}), {}, null, new Uint8Array(2), { length: 1 }]) {
      expect(util.isArray(value)).toBe(Array.isArray(value));
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0][2]).toBe('DEP0044');
  });

  it('converts the supplied actual signal table and rejects invalid names', () => {
    const { util } = implementation();
    for (const signal of [...Object.keys(constants.signals), '', 'sigterm', 'NOT_A_SIGNAL', 15, null, undefined]) {
      expect(outcome(() => util.convertProcessSignalToExitCode(signal)))
        .toEqual(outcome(() => (nativeUtil as any).convertProcessSignalToExitCode(signal)));
    }
  });

  it('marks genuine promises without reading then or accepting lookalikes', () => {
    const { util, handled } = implementation();
    const promise = Promise.resolve(1);
    Object.defineProperty(promise, 'then', { get() { throw Error('observed then'); } });
    const foreign = runInNewContext('Promise.resolve(2)');
    expect(util.markPromiseAsHandled(promise)).toBeUndefined();
    expect(util.markPromiseAsHandled(foreign)).toBeUndefined();
    expect(handled).toEqual([promise, foreign]);
    for (const value of [null, undefined, 1, {}, { then() {} }, Object.create(Promise.prototype), new Proxy(promise, {})]) {
      expect(outcome(() => util.markPromiseAsHandled(value)))
        .toEqual(outcome(() => (nativeUtil as any).markPromiseAsHandled(value)));
    }
    expect(handled).toHaveLength(2);
  });
});
