import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getEventListeners } from 'node:events';
import { nodeTimerCases } from './fixtures/node-timers';

const adapter = readFileSync(new URL('../../packages/registry/spidermonkey/node-compat/adapter.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function section(source: string, start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing timer source boundary');
  return source.slice(a, b);
}
function subject() {
  let time = 0;
  // The real scheduler receives a controlled private monotonic clock. No
  // guest API or upstream source is replaced by these source-only checks.
  const make = Function(section(adapter, 'function createTimerScheduler(now)', 'const timerScheduler =') + ';return createTimerScheduler;')();
  const scheduler = make(() => time);
  const warnings: Array<[string,string]> = [];
  const os = {
    setTimeout: (fn: Function, delay: number, ref: boolean, start: number) => scheduler.schedule(fn, delay, ref, false, start),
    setImmediate: (fn: Function) => scheduler.schedule(fn, 0, true, true),
    clearTimeout: scheduler.clear, timerRef: scheduler.ref, timerNow: scheduler.now,
  };
  const api = Function('os','process', section(bootstrap, 'const timers = (() => {', '// ============================================================\n// child_process module') + ';return {timers,timersPromises};')
    (os, { emitWarning(message: string, name: string) { warnings.push([name,message]); } });
  return { ...api, scheduler, warnings, advance(value: number) { time = value; } };
}

describe('actual timer scheduler source', () => {
  it('keeps unref work eligible without making its deadline a reference', () => {
    const s = subject(), seen: string[] = [];
    s.timers.setTimeout(() => seen.push('unref'), 1).unref();
    expect(s.scheduler.hasReferences()).toBe(false);
    expect(s.scheduler.nextDelay()).toBe(1);
    s.timers.setTimeout(() => seen.push('ref'), 2);
    s.advance(1); s.scheduler.runOne();
    s.advance(2); s.scheduler.runOne();
    expect(seen).toEqual(['unref','ref']);
    expect(s.scheduler.hasReferences()).toBe(false);
  });
  it('finishes an entered callback batch after its last reference completes', () => {
    const s = subject(), seen: number[] = [];
    s.timers.setTimeout(() => seen.push(1), 1);
    s.timers.setTimeout(() => seen.push(2), 1).unref();
    s.advance(2); s.scheduler.runOne();
    expect(s.scheduler.hasReferences()).toBe(true);
    s.scheduler.runOne();
    expect(seen).toEqual([1,2]);
    expect(s.scheduler.hasReferences()).toBe(false);
  });
  it('cancels intervals inside their callbacks and refreshes a fired timeout', () => {
    const s = subject(); let count = 0;
    const interval = s.timers.setInterval(() => { count++; s.timers.clearInterval(interval); }, 1);
    s.advance(1); s.scheduler.runOne();
    expect(count).toBe(1); expect(s.scheduler.nextDelay()).toBe(null);
    const timeout = s.timers.setTimeout(() => count++, 1);
    const old = +timeout;
    s.advance(2); s.scheduler.runOne(); timeout.refresh();
    expect(+timeout).not.toBe(old);
    s.advance(3); s.scheduler.runOne();
    expect(count).toBe(3);
    s.timers.clearTimeout(timeout); timeout.refresh();
    expect(s.scheduler.hasReferences()).toBe(false);
  });
  it('invokes callbacks with shadowed apply properties using the intrinsic', () => {
    const s = subject(); let count = 0;
    const fn = Object.assign(() => { count++; }, {apply() { throw Error('shadow called'); }});
    s.timers.setTimeout(fn, 1); s.timers.setImmediate(fn);
    s.advance(1); while (s.scheduler.hasReferences()) s.scheduler.runOne();
    expect(count).toBe(2);
  });
  it('orders and removes heap entries after cancellation in the middle', () => {
    const s = subject(), expected: Array<[number,number]> = [], seen: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const delay = (i * 37) % 97 + 1;
      const t = s.timers.setTimeout(() => seen.push(i), delay);
      if (i % 3 === 0) s.timers.clearTimeout(t); else expected.push([delay,i]);
    }
    s.advance(100);
    while (s.scheduler.hasReferences()) s.scheduler.runOne();
    expect(seen).toEqual(expected.sort((a,b) => a[0]-b[0] || a[1]-b[1]).map(x => x[1]));
    expect(s.scheduler.nextDelay()).toBe(null);
  });
  it('defers newly queued immediates and permits microtasks between callbacks', async () => {
    const s = subject(), seen: string[] = [];
    s.timers.setImmediate(() => { seen.push('a'); queueMicrotask(() => seen.push('micro')); s.timers.setImmediate(() => seen.push('next')); });
    s.timers.setImmediate(() => seen.push('b'));
    s.scheduler.runOne(); await Promise.resolve(); s.scheduler.runOne();
    expect(seen).toEqual(['a','micro','b']);
    s.scheduler.runOne(); expect(seen).toEqual(['a','micro','b','next']);
    expect(s.scheduler.hasReferences()).toBe(false);
  });
  it('preserves string key identity for timeout cancellation', () => {
    const s = subject(); let ran = false;
    const timer = s.timers.setTimeout(() => { ran = true; }, 1); const id = +timer;
    for (const key of ['0'+id, ' '+id, id+'.0', id+'e0', '+'+id]) s.timers.clearTimeout(key);
    s.advance(1); s.scheduler.runOne(); expect(ran).toBe(true);
  });
  it('accepts the target scheduler inherited and proxy receivers', async () => {
    const s = subject(), scheduler = s.timersPromises.scheduler;
    const inherited = scheduler.yield.call(Object.create(scheduler));
    s.scheduler.runOne(); await inherited;
    const proxied = scheduler.wait.call(new Proxy(scheduler, {}), 1);
    s.advance(1); s.scheduler.runOne(); await proxied;
    expect(() => scheduler.yield.call(null)).toThrow(TypeError);
  });
  it('normalizes durations and emits the target warning categories once where required', () => {
    const s = subject();
    for (const delay of [NaN, NaN, -1, -2, Infinity, 2147483648]) {
      const t = s.timers.setTimeout(() => {}, delay); expect(t._idleTimeout).toBe(1); s.timers.clearTimeout(t);
    }
    expect(s.warnings.map(x => x[0])).toEqual(['TimeoutNaNWarning','TimeoutNegativeWarning','TimeoutOverflowWarning','TimeoutOverflowWarning']);
  });
  it('settles and aborts promises with listener cleanup and the real cause', async () => {
    const s = subject(), controller = new AbortController();
    const wait = s.timersPromises.setTimeout(1, 42, {signal:controller.signal});
    expect(getEventListeners(controller.signal,'abort')).toHaveLength(1);
    s.advance(1); s.scheduler.runOne(); expect(await wait).toBe(42);
    expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
    const cancelled = s.timersPromises.setTimeout(1000, 0, {signal:controller.signal});
    controller.abort(false);
    await expect(cancelled).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR',cause:false});
    expect(s.scheduler.hasReferences()).toBe(false);
    expect(getEventListeners(controller.signal,'abort')).toHaveLength(0);
  });
  it('closes interval iterators and does not reference ref:false promises', async () => {
    const s = subject();
    const iterator = s.timersPromises.setInterval(1,'tick');
    const next = iterator.next(); s.advance(1); s.scheduler.runOne();
    expect(await next).toEqual({value:'tick',done:false}); await iterator.return();
    expect(s.scheduler.hasReferences()).toBe(false);
    s.timersPromises.setTimeout(1000,0,{ref:false});
    s.timersPromises.setImmediate(0,{ref:false});
    expect(s.scheduler.hasReferences()).toBe(false);
  });
});

describe.skipIf(process.versions.node !== target.version)('exact native public timer controls', () => {
  for (const c of nodeTimerCases) it(c.name, () => {
    const result = spawnSync(process.execPath, ['-e',c.source], {encoding:'utf8',timeout:5000});
    expect(result.error).toBeUndefined();
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`node-timers-${c.name}-ok`);
  });
});
