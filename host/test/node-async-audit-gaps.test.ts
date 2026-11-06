import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import nativeAsyncHooks, { AsyncLocalStorage, createHook, asyncWrapProviders } from 'node:async_hooks';
import { createAsyncPlatformControl } from './fixtures/node-async-platform.cjs';
import { createNativeAdapter } from './fixtures/node-native-adapter.cjs';
import { EventEmitter as NativeEventEmitter } from 'node:events';
import * as nativeTimers from 'node:timers';
import * as util from 'node:util';
import * as osNative from 'node:os';
import { describe, expect, it } from 'vitest';
import { createNativeTaskBoundary } from './fixtures/node-native-tasks';

// Focused source/native controls. The real candidate class/timer/listener
// bodies run here, with native engine/error/task dependencies explicitly
// supplied. This does not exercise the guest JSAPI or four-host event loop.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const bootstrap = read('../../packages/registry/node-compat/bootstrap.js');
const target = JSON.parse(read('../../packages/registry/node-compat/target.json'));
function section(source: string, start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing actual async source boundary');
  return source.slice(a, b);
}
const valuesFactory = Function(read('../../third_party/node-core/node-core.js') +
  ';return _createNodeValuesPlatform;')();
const values = valuesFactory({ process, Buffer, util, inspection: util, os: osNative,
  signals: osNative.constants.signals, getDOMException: () => DOMException });
const createCandidateHook = (options: object) => {
  const control = createAsyncPlatformControl();
  try { return control.api.createHook(options); }
  finally { control.close(); }
};

function outcome(make: Function, options: object) {
  try { make(options); return { ok: true }; }
  catch (error: any) { return { name: error.name, code: error.code, message: error.message }; }
}

function timerSubject() {
  const adapter = read('../../packages/registry/spidermonkey/node-compat/adapter.js');
  let time = 0;
  const make = Function('native', 'runWithAsyncContext',
    section(adapter, 'function createTimerScheduler(now)', 'const timerScheduler =') +
    ';return createTimerScheduler;')(
    { getAsyncContext: () => AsyncLocalStorage.snapshot() },
    (scope: Function, fn: Function, receiver: any, args: any[]) =>
      scope(() => Reflect.apply(fn, receiver, args)));
  const scheduler = make(() => time);
  const os = {
    setTimeout: (fn: Function, delay: number, ref: boolean, start: number) =>
      scheduler.schedule(fn, delay, ref, false, start),
    setImmediate: (fn: Function) => scheduler.schedule(fn, 0, true, true),
    clearTimeout: scheduler.clear, timerRef: scheduler.ref, timerNow: scheduler.now,
  };
  const timers = Function('os', 'process', '_nodeAsyncPlatform',
    section(bootstrap, 'const timers = (() => {', 'const _nodeRemovalPlatform =') +
    ';return timers;')(os, process, createNativeTaskBoundary());
  return { timers, scheduler, fire() { time = 1; scheduler.runOne(); } };
}

describe('audited async/event source gaps against exact native reference', () => {
  it('uses the exact audited native version', () => {
    expect(process.versions.node).toBe(target.version);
  });

  it('forwards default-trigger operations through the complete production adapter', () => {
    const calls: unknown[] = [], bad = { valueOf() { throw Error('Unexpected coercion'); } };
    const rejection = Error('Native private validation');
    const adapter = createNativeAdapter({
      getDefaultTriggerAsyncId() { calls.push('get'); return 77; },
      swapDefaultTriggerAsyncId(value: unknown) {
        calls.push(value);
        if (value === bad) throw rejection;
        return -1;
      },
    });
    expect(adapter.getDefaultTriggerAsyncId()).toBe(77);
    expect(adapter.swapDefaultTriggerAsyncId(0)).toBe(-1);
    expect(() => adapter.swapDefaultTriggerAsyncId(bad)).toThrow(rejection);
    expect(calls).toEqual(['get', 0, bad]);
  });

  it('matches AsyncHook option validation and precedence', () => {
    const callback = () => {};
    for (const options of [
      {}, { trackPromises: false }, { trackPromises: true, promiseResolve: callback },
      { trackPromises: false, promiseResolve: callback },
      { trackPromises: false, promiseResolve: 1 },
      { trackPromises: null }, { trackPromises: 0 }, { trackPromises: 'false' },
      { trackPromises: false, init: 1, promiseResolve: callback },
    ]) {
      expect(outcome(createCandidateHook, options)).toEqual(outcome(createHook, options));
    }
  });

  it('exposes the complete declared provider IDs with native order and descriptors', () => {
    withAsyncControl(({ api }) => {
      const providers = api.asyncWrapProviders;
      expect(Reflect.ownKeys(providers)).toEqual(Reflect.ownKeys(asyncWrapProviders));
      expect(Object.getOwnPropertyDescriptors(providers))
        .toEqual(Object.getOwnPropertyDescriptors(asyncWrapProviders));
      expect(Object.getPrototypeOf(providers)).toBe(Object.getPrototypeOf(asyncWrapProviders));
      expect(Object.isFrozen(providers)).toBe(true);
    });
  });

  it('removes listeners without consulting mutable Array.prototype.splice', () => {
    const E = Function('util', 'process', '_nodeValues',
      section(bootstrap, 'const events = (() => {', '// events.setMaxListeners') +
      ';return events;')(util, process, values);
    function exercise(Constructor: any) {
      const emitter = new Constructor(), observed: number[] = [];
      const first = () => observed.push(1), middle = () => observed.push(2), last = () => observed.push(3);
      emitter.on('event', first); emitter.on('event', middle); emitter.on('event', last);
      const original = Array.prototype.splice;
      try {
        Array.prototype.splice = () => { throw Error('Mutable splice was consulted'); };
        emitter.removeListener('event', middle);
      } finally { Array.prototype.splice = original; }
      emitter.emit('event');
      return observed;
    }
    expect(exercise(E)).toEqual(exercise(NativeEventEmitter));
    expect(exercise(E)).toEqual([1, 3]);
  });

  for (const mode of ['object', 'number', 'string', 'close', 'dispose']) {
    it(`clears canceled timer callback/argument ownership via ${mode}`, () => {
      const subject = timerSubject();
      function exercise(api: any) {
        const argument = { retained: true };
        const timer = api.setTimeout(() => { throw Error('Canceled timer ran'); }, 1000, argument);
        try {
          if (mode === 'close') timer.close();
          else if (mode === 'dispose') timer[Symbol.dispose]();
          else api.clearTimeout(mode === 'object' ? timer : mode === 'number' ? +timer : String(+timer));
          return { callback: timer._onTimeout, args: timer._timerArgs,
            destroyed: timer._destroyed, delay: timer._idleTimeout };
        } finally { api.clearTimeout(timer); }
      }
      expect(exercise(subject.timers)).toEqual(exercise(nativeTimers));
      expect(subject.scheduler.hasReferences()).toBe(false);
    });
  }

  it('also clears callback/arguments when an already-fired timeout is canceled', async () => {
    const subject = timerSubject(), argument = {};
    const candidate = subject.timers.setTimeout(() => {}, 1, argument);
    subject.fire();
    let native: any;
    await new Promise<void>(resolve => { native = nativeTimers.setTimeout(resolve, 1, argument); });
    subject.timers.clearTimeout(candidate); nativeTimers.clearTimeout(native);
    expect([candidate._onTimeout, candidate._timerArgs, candidate._destroyed, candidate._idleTimeout])
      .toEqual([native._onTimeout, native._timerArgs, native._destroyed, native._idleTimeout]);
    expect(candidate._timerArgs).toBeUndefined();
  });
});

function hookMetadata(api: any) {
  const hook = api.createHook({});
  const prototype = Object.getPrototypeOf(hook);
  const functions = [api.createHook, api.executionAsyncId, api.triggerAsyncId,
    api.executionAsyncResource, Object.getOwnPropertyDescriptor(api, 'AsyncLocalStorage')!.get];
  return {
    namespace: Reflect.ownKeys(api),
    namespaceDescriptors: Reflect.ownKeys(api).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(api, key)!;
      return [key, descriptor.writable, descriptor.enumerable, descriptor.configurable,
        typeof descriptor.get, typeof descriptor.set];
    }),
    functions: functions.map(fn => ({
      name: fn.name, length: fn.length, ownKeys: Reflect.ownKeys(fn),
      ownDescriptors: Reflect.ownKeys(fn).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(fn, key)!;
        return [key, descriptor.writable, descriptor.enumerable, descriptor.configurable,
          key === 'name' || key === 'length' ? descriptor.value : typeof descriptor.value];
      }),
      functionPrototype: Object.getPrototypeOf(fn) === Function.prototype,
      constructible: (() => { try { Reflect.construct(Object, [], fn); return true; } catch { return false; } })(),
    })),
    hookKeys: Reflect.ownKeys(hook).map(key => typeof key === 'symbol' ? key.description : key),
    hookDescriptors: Object.getOwnPropertySymbols(hook).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(hook, key)!;
      return [descriptor.writable, descriptor.enumerable, descriptor.configurable, descriptor.value];
    }),
    prototypeKeys: Reflect.ownKeys(prototype),
    prototypeDescriptors: Reflect.ownKeys(prototype).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      return [key, descriptor.writable, descriptor.enumerable, descriptor.configurable,
        descriptor.value.name, descriptor.value.length];
    }),
    className: prototype.constructor.name,
    classLength: prototype.constructor.length,
    classParent: Object.getPrototypeOf(prototype.constructor) === Function.prototype,
    prototypeParent: Object.getPrototypeOf(prototype) === Object.prototype,
    constructorViaNew: Object.getPrototypeOf(new api.createHook({})) === prototype,
    classWithoutNew: (() => { try { prototype.constructor({}); return 'accepted'; }
      catch (error: any) { return error.name; } })(),
  };
}

function withAsyncControl(fn: (control: any) => void) {
  const control = createAsyncPlatformControl();
  try { fn(control); } finally { control.close(); }
}

describe('AsyncHook source registry and public object native controls', () => {
  it('matches ordinary public functions, namespace insertion order and source-private symbol descriptors', () => {
    withAsyncControl(({ api }) => expect(hookMetadata(api)).toEqual(hookMetadata(nativeAsyncHooks)));
  });

  it('keeps a stable mutable ordinary top-level resource', () => {
    withAsyncControl(({ api }) => {
      const resource = api.executionAsyncResource();
      const shape = (value: any, again: any) => ({
        ordinary: Object.getPrototypeOf(value) === Object.prototype,
        keys: Reflect.ownKeys(value), extensible: Object.isExtensible(value), stable: value === again,
      });
      const native = JSON.parse(execFileSync(process.execPath, ['-e', `
        const {executionAsyncResource: get} = require('node:async_hooks');
        const shape = ${shape.toString()};
        console.log(JSON.stringify(shape(get(), get())));
      `], { encoding: 'utf8' }));
      expect(shape(resource, api.executionAsyncResource())).toEqual(native);
      resource.control = 1;
      expect(api.executionAsyncResource()).toBe(resource);
      expect(api.executionAsyncResource().control).toBe(1);
    });
  });

  it('reads inherited option getters before validating, in the pinned order', () => {
    function exercise(api: any, failure: string | undefined) {
      const reads: string[] = [];
      const options = Object.create(Object.fromEntries(
        ['init', 'before', 'after', 'destroy', 'promiseResolve', 'trackPromises'].map(name =>
          [name, undefined])));
      for (const name of ['init', 'before', 'after', 'destroy', 'promiseResolve', 'trackPromises']) {
        Object.defineProperty(Object.getPrototypeOf(options), name, { get() {
          reads.push(name);
          if (failure === name) throw new Error('getter ' + name);
          return name === 'init' ? 1 : name === 'trackPromises' ? false : undefined;
        } });
      }
      return { reads, result: outcome(api.createHook, options) };
    }
    withAsyncControl(({ api }) => {
      for (const failure of [undefined, 'before', 'trackPromises'])
        expect(exercise(api, failure)).toEqual(exercise(nativeAsyncHooks, failure));
      for (const options of [undefined, null, 0, true, 'text', () => {}])
        expect(outcome(api.createHook, options)).toEqual(outcome(nativeAsyncHooks.createHook, options));
    });
  });

  it('registers borrowed and inherited receivers and preserves callback getter/read order', () => {
    function exercise(api: any) {
      const trace: any[] = [];
      const base = api.createHook({ init() { trace.push(['callback', this === inherited]); } });
      const inherited = Object.create(base), prototype = Object.getPrototypeOf(base);
      const symbols = Object.getOwnPropertySymbols(base);
      const init = symbols.find(key => key.description === 'init')!;
      const callback = base[init];
      Object.defineProperty(inherited, init, { get() { trace.push('get:init'); return callback; } });
      const bare = {};
      try {
        expect(prototype.enable.call(bare)).toBe(bare);
        expect(prototype.enable.call(inherited)).toBe(inherited);
        expect(prototype.enable.call(inherited)).toBe(inherited);
        const resource = new api.AsyncResource('HookReceiverControl', { requireManualDestroy: true });
        resource.runInAsyncScope(() => {});
        expect(prototype.disable.call(inherited)).toBe(inherited);
        expect(prototype.disable.call(inherited)).toBe(inherited);
      } finally {
        prototype.disable.call(inherited);
        prototype.disable.call(bare);
      }
      for (const receiver of [null, undefined, 0, 'value']) {
        try { prototype.enable.call(receiver); trace.push(['borrow', typeof receiver, 'ok']); }
        catch (error: any) { trace.push(['borrow', typeof receiver, error.name]); }
        finally { prototype.disable.call(receiver); }
      }
      return trace;
    }
    withAsyncControl(({ api }) => expect(exercise(api)).toEqual(exercise(nativeAsyncHooks)));
  });

  it('defers enable/disable mutations until outermost dispatch and preserves re-enabled insertion order', () => {
    function exercise(api: any) {
      const trace: any[] = [];
      let nested = false;
      const resource = new api.AsyncResource('HookDispatchControl', { requireManualDestroy: true });
      const hook = (name: string, callback?: Function) => api.createHook({ before() {
        trace.push([name, nested ? 'nested' : 'outer', this === named[name]]);
        callback?.();
      } });
      const named: any = {};
      named.first = hook('first', () => {
        if (nested) return;
        named.second.disable(); named.third.enable(); named.second.enable();
        named.first.disable(); named.first.enable();
        nested = true;
        try { resource.runInAsyncScope(() => trace.push('nested body')); }
        finally { nested = false; }
      });
      named.second = hook('second'); named.third = hook('third');
      try {
        named.first.enable(); named.second.enable();
        resource.runInAsyncScope(() => trace.push('outer body'));
        named.first.disable();
        resource.runInAsyncScope(() => trace.push('next body'));
      } finally { for (const item of Object.values(named) as any[]) item.disable(); }
      return trace;
    }
    withAsyncControl(({ api }) => expect(exercise(api)).toEqual(exercise(nativeAsyncHooks)));
  });

  it('observes callback symbol mutations after construction and dispatch-time getter changes', () => {
    function exercise(api: any) {
      const trace: string[] = [];
      const resource = new api.AsyncResource('HookMutationControl', { requireManualDestroy: true });
      const hook = api.createHook({ before() { trace.push('original'); } });
      const before = Object.getOwnPropertySymbols(hook).find(key => key.description === 'before')!;
      let reads = 0;
      Object.defineProperty(hook, before, { configurable: true, get() {
        reads++;
        return () => trace.push('replacement ' + reads);
      } });
      try {
        hook.enable();
        resource.runInAsyncScope(() => trace.push('body'));
        hook.disable();
      } finally { hook.disable(); }
      return { reads, trace };
    }
    withAsyncControl(({ api }) => expect(exercise(api)).toEqual(exercise(nativeAsyncHooks)));
  });

  it('dispatches lifecycle events from a real native AsyncResource through the same registry', () => {
    withAsyncControl(control => {
      const events: string[] = [];
      let owner: any, id: number;
      const hook = control.api.createHook({
        init(asyncId: number, type: string, triggerId: number, resource: object) {
          if (type !== 'AsyncHookControl') return;
          owner = resource; id = asyncId;
          expect(resource).toBeInstanceOf(nativeAsyncHooks.AsyncResource);
          expect(triggerId).toBe((resource as any).triggerAsyncId());
          events.push('init');
        },
        before(asyncId: number) {
          if (asyncId !== id) return;
          expect(control.api.executionAsyncResource()).toBe(owner);
          expect(control.api.executionAsyncId()).toBe(id);
          events.push('before');
        },
        after(asyncId: number) { if (asyncId === id) events.push('after'); },
      }).enable();
      try { control.runNative(() => events.push('body')); }
      finally { hook.disable(); }
      expect(events).toEqual(['init', 'before', 'body', 'after']);
    });
  });
});

describe('AsyncHook callback-count native boundaries', () => {
  it('keeps dispatch gated by registered counts when callback symbols change', () => {
    function exercise(api: any) {
      const trace: string[] = [];
      const resource = new api.AsyncResource('HookCountControl', { requireManualDestroy: true });
      const hook = api.createHook({ init() {} });
      const before = Object.getOwnPropertySymbols(hook).find(key => key.description === 'before')!;
      hook.enable();
      try {
        hook[before] = () => trace.push('late before');
        resource.runInAsyncScope(() => trace.push('body'));
      } finally { hook[before] = undefined; hook.disable(); }
      return trace;
    }
    // A fresh native process has no Vitest/fixture hooks contributing to the
    // global before count. The control otherwise tests a different registry.
    const native = JSON.parse(execFileSync(process.execPath, ['-e', `
      const api = require('node:async_hooks');
      const exercise = ${exercise.toString()};
      process.stdout.write(JSON.stringify(exercise(api)));
    `], { encoding: 'utf8' }));
    withAsyncControl(({ api }) => expect(exercise(api)).toEqual(native));
  });

  it('publishes destroy-count changes even while other callback types stay enabled', () => {
    withAsyncControl(control => {
      const before = control.api.createHook({ before() {}, trackPromises: false }).enable();
      const destroy = control.api.createHook({ destroy() {}, trackPromises: false });
      try {
        destroy.enable();
        expect(control.destroyTrackingChanges.at(-1)).toBe(true);
        destroy.disable();
        expect(control.destroyTrackingChanges.at(-1)).toBe(false);
      } finally { destroy.disable(); before.disable(); }
    });
  });

  it('retains enabled empty hooks without manufacturing callbacks', () => {
    withAsyncControl(control => {
      const hook = control.api.createHook({}).enable();
      try { expect(control.enabledHooksExist()).toBe(true); }
      finally { hook.disable(); }
      expect(control.enabledHooksExist()).toBe(false);
    });
  });

  it('rejects nonpositive destroy IDs at the public emission boundary', () => {
    function exercise(api: any) {
      const hook = api.createHook({ destroy() {} }).enable();
      const resource = new api.AsyncResource('HookDestroyControl', { requireManualDestroy: true });
      const idSymbol = Object.getOwnPropertySymbols(resource).find(key => key.description === 'async_id_symbol')!;
      const results: any[] = [];
      try {
        for (const id of [undefined, NaN, 0, -1]) {
          const receiver = { [idSymbol]: id };
          results.push(resource.emitDestroy.call(receiver) === receiver);
        }
      } finally { hook.disable(); }
      return results;
    }
    withAsyncControl(({ api }) => expect(exercise(api)).toEqual(exercise(nativeAsyncHooks)));
  });
});
