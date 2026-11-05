import { readFileSync } from 'node:fs';
import { AsyncLocalStorage, createHook, asyncWrapProviders } from 'node:async_hooks';
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
const asyncSource = read('../../third_party/node-core/async-platform-adapter.js');
const createCandidateHook = Function('platform', 'codes', 'callbacks', 'modifyHook',
  section(asyncSource, '    class AsyncHook {', '    const async_id_symbol') +
  ';return options => new AsyncHook(options);')(
  { values }, values.errors.codes, new WeakMap(),
  () => { throw Error('Hook activation is outside this constructor control'); });

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
    const core = read('../../third_party/node-core/node-core.js');
    const expression = section(core, 'asyncWrapProviders:', '    };')
      .slice('asyncWrapProviders:'.length).trim().replace(/,$/, '');
    const providers = Function('ObjectFreeze', 'ObjectAssign', 'ObjectCreate',
      'return (' + expression + ');')(Object.freeze, Object.assign, Object.create);
    expect(Reflect.ownKeys(providers)).toEqual(Reflect.ownKeys(asyncWrapProviders));
    expect(Object.getOwnPropertyDescriptors(providers))
      .toEqual(Object.getOwnPropertyDescriptors(asyncWrapProviders));
    expect(Object.getPrototypeOf(providers)).toBe(Object.getPrototypeOf(asyncWrapProviders));
    expect(Object.isFrozen(providers)).toBe(true);
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
