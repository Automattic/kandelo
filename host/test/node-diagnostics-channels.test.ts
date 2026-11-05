import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import * as nativeUtil from 'node:util';
import { describe, expect, it } from 'vitest';

const native = createRequire(import.meta.url)('node:diagnostics_channel');
const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const consoleFixture = createRequire(import.meta.url)('./fixtures/node-console-platform.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const factories = Function(`${bundle};return { diagnostics: _createNodeDiagnosticsPlatform, values: _createNodeValuesPlatform };`)();
function implementation() {
  const ticks: Array<() => void> = [], warnings: unknown[][] = [];
  const process = { platform: 'kandelo', nextTick(fn: () => void) { ticks.push(fn); },
    emitWarning(...args: unknown[]) { warnings.push(args); } };
  const values = factories.values({ process, Buffer, util: nativeUtil, inspection: nativeUtil,
    os: {}, signals: constants.signals, getDOMException: () => DOMException });
  const platform = factories.diagnostics({ process, values, types: nativeUtil.types });
  return { ...platform, ticks, warnings };
}
function error(fn: () => unknown) {
  try { fn(); return undefined; }
  catch (e: any) { return { name: e.name, code: e.code }; }
}

describe.skipIf(process.versions.node !== target.version)('shared diagnostics channel contracts', () => {
  it('matches public module shape, identities, prototypes and bounded descriptors', () => {
    const { api } = implementation();
    expect(Object.keys(api).sort()).toEqual(Object.keys(native).sort());
    const symbol = Symbol('channel');
    expect(api.channel(symbol)).toBe(api.channel(symbol));
    expect(api.channel(symbol)).not.toBe(api.channel(Symbol('channel')));
    const c = api.channel(symbol), fn = () => {};
    expect(c instanceof api.Channel).toBe(true);
    c.subscribe(fn); expect(c instanceof api.Channel).toBe(true);
    expect(c.hasSubscribers).toBe(true); expect(c.unsubscribe(fn)).toBe(true);
    expect(c.hasSubscribers).toBe(false);
    const actual = api.boundedChannel('descriptor'), expected = native.boundedChannel('descriptor');
    for (const key of ['start', 'end']) {
      const a = Object.getOwnPropertyDescriptor(actual, key)!, b = Object.getOwnPropertyDescriptor(expected, key)!;
      expect([a.enumerable, a.writable, a.configurable]).toEqual([b.enumerable, b.writable, b.configurable]);
    }
    for (const value of [null, undefined, 1, {}, () => {}]) {
      expect(error(() => api.channel(value))).toEqual(error(() => native.channel(value)));
    }
  });

  it('retains a publication snapshot while subscriptions mutate', () => {
    function scenario(dc: any) {
      const c = dc.channel(Symbol('snapshot')), events: string[] = [];
      const third = () => events.push('third');
      const second = () => events.push('second');
      const first = () => { events.push('first'); c.unsubscribe(second); c.subscribe(third); };
      c.subscribe(first); c.subscribe(second);
      c.publish({}); c.publish({});
      c.unsubscribe(first); c.unsubscribe(second); while (c.unsubscribe(third)) {}
      return events;
    }
    expect(scenario(implementation().api)).toEqual(scenario(native));
  });

  it('queues subscriber failures without interrupting the publication snapshot', () => {
    const { api, ticks } = implementation(), c = api.channel('exceptions');
    const failure = Error('subscriber'), events: string[] = [];
    c.subscribe(() => { throw failure; });
    c.subscribe(() => events.push('second'));
    expect(() => c.publish({})).not.toThrow();
    expect(events).toEqual(['second']); expect(ticks).toHaveLength(1);
    try { ticks[0](); throw Error('missing queued failure'); } catch (e) { expect(e).toBe(failure); }
  });

  it('enters real store scopes and restores them after return, throw and disposal', () => {
    function scenario(dc: any) {
      const c = dc.channel(Symbol('store')), store = new AsyncLocalStorage();
      const events: unknown[] = [];
      c.bindStore(store, (data: any) => ({ id: data.id }));
      const observer = () => events.push(store.getStore()); c.subscribe(observer);
      const receiver = {};
      const result = c.runStores({ id: 7 }, function(this: unknown, n: number) {
        events.push(this === receiver, store.getStore()); return n + 1;
      }, receiver, 4);
      events.push(result, store.getStore());
      const scope = c.withStoreScope({ id: 8 }); events.push(store.getStore());
      scope[Symbol.dispose](); scope[Symbol.dispose](); events.push(store.getStore());
      const failure = Error('callback');
      try { c.runStores({ id: 9 }, () => { throw failure; }); } catch (e) { events.push(e === failure); }
      events.push(store.getStore(), c.unbindStore(store), c.unsubscribe(observer), c.hasSubscribers);
      return events;
    }
    expect(scenario(implementation().api)).toEqual(scenario(native));
  });

  it('balances bounded windows and matches the target mid-trace subscription behavior', () => {
    function scenario(dc: any, name: string) {
      const window = dc.boundedChannel(name), events: string[] = [];
      const start = () => events.push('start'), end = () => events.push('end');
      window.subscribe({ start });
      const result = window.run({}, () => { window.end.subscribe(end); events.push('call'); return 3; });
      window.unsubscribe({ start, end });
      return { result, events, active: window.hasSubscribers };
    }
    expect(scenario(implementation().api, 'source-mid-trace')).toEqual(scenario(native, 'native-mid-trace'));
  });

  it('traces sync results and errors with original context and receiver', () => {
    function scenario(dc: any, name: string) {
      const tracing = dc.tracingChannel(name), events: string[] = [];
      const handlers = Object.fromEntries(['start', 'end', 'error'].map(key => [key, () => events.push(key)]));
      tracing.subscribe(handlers);
      const context: any = {}, receiver = { n: 4 };
      const result = tracing.traceSync(function(this: typeof receiver, n: number) { return this.n + n; }, context, receiver, 3);
      const failure = Error('sync');
      try { tracing.traceSync(() => { throw failure; }, context); } catch (e) { events.push(e === failure ? 'same' : 'different'); }
      tracing.unsubscribe(handlers);
      return { result, contextResult: context.result, sameError: context.error === failure, events };
    }
    expect(scenario(implementation().api, 'source-sync')).toEqual(scenario(native, 'native-sync'));
  });

  it('traces native Promise settlement and preserves custom thenable identity', async () => {
    async function scenario(dc: any, name: string) {
      const tracing = dc.tracingChannel(name), events: string[] = [];
      const handlers = Object.fromEntries(['start', 'end', 'asyncStart', 'asyncEnd', 'error'].map(key => [key, () => events.push(key)]));
      tracing.subscribe(handlers);
      const context: any = {}, promise = Promise.resolve(7);
      const result = tracing.tracePromise(() => promise, context);
      const nativeChained = result !== promise;
      await result;
      const thenable = { then(resolve: (value: number) => unknown) { resolve(9); } };
      const sameThenable = tracing.tracePromise(() => thenable, context) === thenable;
      const failure = Error('reject');
      try { await tracing.tracePromise(() => Promise.reject(failure), context); } catch (e) { events.push(e === failure ? 'same' : 'different'); }
      tracing.unsubscribe(handlers);
      return { nativeChained, sameThenable, value: context.result, sameError: context.error === failure, events };
    }
    expect(await scenario(implementation().api, 'source-promise')).toEqual(await scenario(native, 'native-promise'));
  });

  it('wraps callback position with call and continuation ownership', () => {
    function scenario(dc: any, name: string) {
      const tracing = dc.tracingChannel(name), events: string[] = [];
      const handlers = Object.fromEntries(['start', 'end', 'asyncStart', 'asyncEnd'].map(key => [key, () => events.push(key)]));
      tracing.subscribe(handlers);
      const context: any = {}, receiver = { id: 1 };
      const returned = tracing.traceCallback(function(this: unknown, cb: Function, value: number) {
        events.push(this === receiver ? 'receiver' : 'wrong'); cb.call(receiver, null, value); return 'returned';
      }, 0, context, receiver, function(this: unknown, err: unknown, value: number) {
        events.push(this === receiver && err === null && value === 5 ? 'callback' : 'wrong');
      }, 5);
      tracing.unsubscribe(handlers);
      return { returned, value: context.result, events };
    }
    expect(scenario(implementation().api, 'source-callback')).toEqual(scenario(native, 'native-callback'));
  });

  it('publishes actual module Console calls once before formatting/writing', () => {
    const platform = implementation(), events: unknown[][] = [];
    const owner = consoleFixture.create({ diagnostics: platform });
    const Console = owner.api.Console;
    const observer = (args: any[], name: string) => { events.push([name, ...args]); args[0] = 'observed'; };
    for (const name of ['log', 'info', 'debug', 'warn', 'error']) platform.api.subscribe('console.' + name, observer);
    const console = new Console({ stdout: owner.stdout, stderr: owner.stdout, colorMode: false });
    for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name]('original', 1);
    expect(events.map(event => event[0])).toEqual(['console.log', 'console.info', 'console.debug', 'console.warn', 'console.error']);
    expect(owner.out).toEqual(Array(5).fill('observed 1\n'));
    owner.close();
    for (const name of ['log', 'info', 'debug', 'warn', 'error']) platform.api.unsubscribe('console.' + name, observer);
  });

  it('keeps producer subscription state coherent when storage grows', () => {
    const platform = implementation(), events: number[] = [];
    const first = platform.registerProducer('producer:0');
    const listener = (value: number) => events.push(value);
    platform.api.subscribe('producer:0', listener);
    for (let i = 1; i < 1030; i++) platform.registerProducer('producer:' + i);
    expect(first.hasSubscribers).toBe(true); first.publish(7);
    platform.api.unsubscribe('producer:0', listener);
    expect(first.hasSubscribers).toBe(false); first.publish(8);
    expect(events).toEqual([7]);
  });
});
