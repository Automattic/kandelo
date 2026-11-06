import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:os';
import * as util from 'node:util';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createNativeAdapter } from './fixtures/node-native-adapter.cjs';

const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const factories = Function(`${bundle};return { vm:_createNodeVmPlatform, values:_createNodeValuesPlatform };`)();
function subject(experimentalModules = false) {
  const values = factories.values({ process, Buffer, util, inspection: util, os: {}, signals: constants.signals });
  const realms = new WeakMap<object, vm.Context>();
  const calls: string[] = [];
  const native = {
    __kandeloVmModuleOperation(operation: string) {
      calls.push('module:' + operation);
      if (operation !== 'constants') throw Error('No guest module operation in this dependency control');
      const raw = createRequire(import.meta.url)('internal/test/binding').internalBinding('module_wrap');
      return Object.fromEntries(Object.entries(raw).filter(([name]) =>
        /^k(?:Uninstantiated|Instantiating|Instantiated|Evaluating|Evaluated|Errored|SourcePhase|EvaluationPhase)$/.test(name)));
    },
    __kandeloVmMakeContext(sandbox: object, options: any) {
      calls.push('create');
      const context = vm.createContext(options.noContextify ? vm.constants.DONT_CONTEXTIFY : sandbox, { name: options.name, origin: options.origin,
        codeGeneration: { strings: options.strings, wasm: options.wasm } });
      const global = vm.runInContext('globalThis', context);
      realms.set(global, context); return global;
    },
    __kandeloVmCompile(code: string, options: any) { calls.push('compile'); return new vm.Script(code, options); },
    __kandeloVmRunInContext(script: vm.Script, global: object, options: any) {
      calls.push('run');
      return global === globalThis ? script.runInThisContext(options) : script.runInContext(realms.get(global)!, options);
    },
    __kandeloVmCompileFunction(code: string, params: string[], global: object, options: any, extensions: object[]) {
      calls.push('function');
      return vm.compileFunction(code, params, { ...options, contextExtensions: extensions,
        parsingContext: global === globalThis ? undefined : realms.get(global) });
    },
  };
  // Real native VM contexts/scripts/functions are explicit backend boundaries.
  // This does not execute native-vm.cpp or Kandelo's context property hooks,
  // shared-memory policy, metadata, realm rooting or exception marshalling.
  return { api: factories.vm({ values, native, process, global: globalThis,
    types: util.types, inspection: util, assert: createRequire(import.meta.url)('node:assert'),
    getOptionValue: (name: string) => name === '--experimental-vm-modules' && experimentalModules }), calls };
}
function outcome(fn: () => unknown) {
  try { return { value: fn() }; } catch (error: any) {
    return { error: { name: error.name, code: error.code, message: error.message } };
  }
}

describe.skipIf(process.versions.node !== target.version)('pinned public VM over explicit native realm boundary', () => {
  it('admits module exports only through the supplied real option state', () => {
    const off = subject(), on = subject(true);
    for (const name of ['Module', 'SourceTextModule', 'SyntheticModule']) {
      expect(off.api[name]).toBeUndefined();
      expect(typeof on.api[name]).toBe('function');
      expect(on.api[name].name).toBe(name);
    }
    expect(off.calls).toEqual([]);
    expect(on.calls).toEqual(['module:constants']);
  });

  it('forwards module operations through the complete production prefix', () => {
    const owner = {}, result = {}, calls: unknown[][] = [];
    const adapter = createNativeAdapter({
      __kandeloVmModuleOperation(...args: unknown[]) { calls.push(args); return result; },
    });
    expect(adapter.__kandeloVmModuleOperation('status', owner)).toBe(result);
    expect(calls).toEqual([['status', owner]]);
    expect(() => createNativeAdapter({}).__kandeloVmModuleOperation('status', owner))
      .toThrow('native VM module records are unavailable');
  });

  it('retains the original sandbox identity and real idempotent context association', () => {
    const { api, calls } = subject(), sandbox = { value: 1 };
    expect(api.createContext(sandbox)).toBe(sandbox);
    expect(api.isContext(sandbox)).toBe(true);
    expect(api.createContext(sandbox, null)).toBe(sandbox); // Already contextified: options are not read.
    expect(calls).toEqual(['create']);
    expect(api.runInContext('value + 1', sandbox)).toBe(2);
    const global = api.runInContext('globalThis', sandbox);
    expect(global).not.toBe(sandbox); expect(api.isContext(global)).toBe(false);
    expect(api.isContext(Object.create(sandbox))).toBe(false);
    expect(api.isContext({})).toBe(false); expect(api.isContext([])).toBe(false);
  });

  it('executes unchanged upstream context identity/brand assertions with both API owners', () => {
    const path = fileURLToPath(new URL('../../.context/nodejs-lts-cache-v2/node-v26.13.0/test/parallel/test-vm-is-context.js', import.meta.url));
    const source = readFileSync(path, 'utf8'), nativeRequire = createRequire(path);
    for (const owner of [subject().api, vm]) {
      Function('require', '__filename', '__dirname', source)
        ((name: string) => name === 'vm' ? owner : nativeRequire(name), path, dirname(path));
    }
  });

  it('matches exact public validation and coercion before native operations', () => {
    const { api, calls } = subject();
    for (const value of [null, undefined, 1, 'text', Symbol('context'), () => {}]) {
      expect(outcome(() => api.isContext(value))).toEqual(outcome(() => vm.isContext(value as any)));
    }
    for (const options of [null, 1, { name: 1 }, { origin: 1 }, { codeGeneration: null },
      { codeGeneration: { strings: 1 } }, { microtaskMode: 'wrong' }, { importModuleDynamically: 1 }]) {
      expect(outcome(() => api.createContext({}, options))).toEqual(outcome(() => vm.createContext({}, options as any)));
    }
    for (const options of [null, 1, { filename: 1 }, { lineOffset: 0.5 }, { columnOffset: Infinity },
      { cachedData: {} }, { produceCachedData: 1 }, { importModuleDynamically: 1 }]) {
      expect(outcome(() => new api.Script('42', options))).toEqual(outcome(() => new vm.Script('42', options as any)));
    }
    for (const [code, params, options] of [[1], ['return 1', [1]], ['return 1', 'x'],
      ['return 1', [], null], ['return 1', [], { parsingContext: {} }],
      ['return 1', [], { contextExtensions: {} }], ['return 1', [], { contextExtensions: [1] }]]) {
      expect(outcome(() => api.compileFunction(code, params, options)))
        .toEqual(outcome(() => vm.compileFunction(code as any, params as any, options as any)));
    }
    expect(calls).toEqual([]);
  });

  it('owns compiled scripts privately and reuses them in real contexts', () => {
    const { api, calls } = subject();
    const a = api.createContext({ value: 2 }), b = api.createContext({ value: 5 });
    const script = new api.Script('value * 2', { filename: 'scope.js', lineOffset: 3, columnOffset: 2 });
    expect(script.runInContext(a)).toBe(4); expect(script.runInContext(b)).toBe(10);
    expect(Object.hasOwn(script, '_h')).toBe(false);
    expect(calls.filter(x => x === 'compile')).toHaveLength(1);
    expect(api.runInNewContext('x + 1', { x: 3 })).toBe(4);
    expect(api.runInThisContext('1 + 2')).toBe(3);
    expect(api.createScript('6 * 7').runInThisContext()).toBe(42);
    for (const options of [{ timeout: 0 }, { timeout: 1.5 }, { timeout: '5' },
      { displayErrors: 1 }, { breakOnSigint: 1 }]) {
      expect(outcome(() => script.runInContext(a, options)))
        .toEqual(outcome(() => new vm.Script('value * 2').runInContext(vm.createContext({ value: 2 }), options as any)));
    }
  });

  it('dispatches separate function body/parameters and actual live context extensions', () => {
    const { api } = subject();
    const sandbox = api.createContext({ base: 10 }), first = { x: 1 }, second = { x: 2 };
    const fn = api.compileFunction('return base + x + café', ['café'],
      { parsingContext: sandbox, contextExtensions: [first, second], filename: 'function.js' });
    expect(fn(3)).toBe(15); second.x = 5; expect(fn(3)).toBe(18);
    expect(fn.length).toBe(1);
    expect(outcome(() => api.compileFunction('return {', ['x'])).error?.name).toBe('SyntaxError');
  });

  it('returns a real isolated global in DONT_CONTEXTIFY mode with stable context identity', () => {
    const { api } = subject();
    const context = api.createContext(api.constants.DONT_CONTEXTIFY);
    expect(api.runInContext('globalThis', context)).toBe(context);
    expect(api.isContext(context)).toBe(true);
    expect(api.createContext(context, null)).toBe(context);
    expect(Object.keys(context)).toEqual([]);
    expect(context.Array).not.toBe(Array);
    api.runInContext('globalThis.value = 1', context);
    expect(context.value).toBe(1);
    context.value = 2;
    expect(api.runInContext('value', context)).toBe(2);
    expect((globalThis as any).value).toBeUndefined();
    Object.freeze(context);
    expect(Object.isFrozen(context)).toBe(true);
    expect(api.runInContext('Object.isFrozen(globalThis)', context)).toBe(true);
    expect(outcome(() => api.runInContext('unboundPlainContextValue', context)).error?.name).toBe('ReferenceError');
  });

  it('uses actual plain globals for new-context execution and function compilation', () => {
    const { api } = subject();
    expect(api.runInNewContext('Object.freeze(globalThis); typeof process', api.constants.DONT_CONTEXTIFY)).toBe('undefined');
    expect(new api.Script('Object.freeze(globalThis); typeof process')
      .runInNewContext(api.constants.DONT_CONTEXTIFY)).toBe('undefined');
    const context = api.createContext(api.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false } });
    expect(api.compileFunction('return 6 * 7', [], { parsingContext: context })()).toBe(42);
    expect(outcome(() => api.runInContext('eval("1")', context)).error?.name).toBe('EvalError');
    expect(outcome(() => api.runInContext('Function("return 1")()', context)).error?.name).toBe('EvalError');
  });

  it('keeps unimplemented deadlines, cache, microtasks and import ownership explicit', () => {
    const { api } = subject(), context = api.createContext({});
    for (const action of [() => api.runInContext('42', context, { timeout: 1 }),
      () => new api.Script('42', { cachedData: Buffer.alloc(0) }),
      () => new api.Script('42', { lineOffset: -1 }),
      () => api.createContext({}, { microtaskMode: 'afterEvaluate' }),
      () => new api.Script('42', { importModuleDynamically() {} })]) {
      expect(outcome(action)).toHaveProperty('error.code', 'ERR_NOT_IMPLEMENTED');
    }
    // These are honest-gap assertions, not passing feature conformance.
    expect(Object.isFrozen(api.constants)).toBe(true);
  });
});
