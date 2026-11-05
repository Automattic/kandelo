import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as native from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:os';
import { describe, expect, it } from 'vitest';
const fixture = createRequire(import.meta.url)('./fixtures/node-child-owner.cjs');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function trace(child: any) {
  const events: any[] = [];
  child.on('spawn', () => events.push(['spawn']));
  child.on('exit', (code: any, signal: any) => events.push(['exit', code, signal, child.exitCode, child.signalCode]));
  child.on('error', (e: any) => events.push(['error', e.code, e.syscall]));
  const done = new Promise(resolve => child.on('close', (code: any, signal: any) => { events.push(['close', code, signal]); resolve(events); }));
  return { events, done };
}
describe.skipIf(process.versions.node !== target.version)('child outcome and lifecycle owners over actual host process boundaries', () => {
  it('publishes spawn/exit/close and real status fields in native order', async () => {
    const candidate = fixture.create();
    let reference: native.ChildProcess | undefined;
    try {
      const a = candidate.spawn(process.execPath, ['-e', 'process.exit(37)'], { stdio: 'ignore' });
      const b = native.spawn(process.execPath, ['-e', 'process.exit(37)'], { stdio: 'ignore' });
      reference = b;
      const left = trace(a), right = trace(b);
      expect(a instanceof candidate.ChildProcess).toBe(true);
      expect(a.stdio).toEqual([null, null, null]);
      expect(a.connected).toBe(false); expect(a.exitCode).toBe(null); expect(a.signalCode).toBe(null);
      expect(a.spawnfile).toBe(b.spawnfile); expect(a.spawnargs).toEqual(b.spawnargs);
      expect(await left.done).toEqual(await right.done);
      expect(a.kill(0)).toBe(false);
    } finally { await Promise.all([candidate.close(), fixture.close(reference)]); }
  });
  it('preserves signal termination and controls the exact live process reference', async () => {
    const candidate = fixture.create();
    let reference: native.ChildProcess | undefined;
    try {
      const args = ['-e', 'setInterval(()=>{},1000)'];
      const a = candidate.spawn(process.execPath, args, { stdio: 'ignore' });
      const b = native.spawn(process.execPath, args, { stdio: 'ignore' });
      reference = b;
      const left = trace(a), right = trace(b);
      expect(a.unref()).toBe(a); expect(a.ref()).toBe(a); expect(candidate.controls).toEqual([false, true]);
      await Promise.all([once(a, 'spawn'), once(b, 'spawn')]);
      expect(a.kill('SIGTERM')).toBe(true); b.kill('SIGTERM');
      expect(await left.done).toEqual(await right.done);
      a.unref(); expect(candidate.controls).toEqual([false, true]);
    } finally { await Promise.all([candidate.close(), fixture.close(reference)]); }
  });
  it('reports failed spawn without successful streams, false status or duplicate callback', async () => {
    const file = '/kandelo-no-such-spawn-fixture';
    const reference = native.spawn(file, [], { stdio: 'ignore' });
    const error: any = await new Promise(resolve => reference.once('error', resolve));
    const candidate = fixture.create({ spawnError: error });
    const a = candidate.spawn(file, [], { stdio: 'ignore' }), observed = trace(a);
    let calls = 0;
    const callback = new Promise(resolve => candidate.runWithCallback(a, file, (e: any) => { calls++; resolve(e); }));
    expect((await callback as any).code).toBe(error.code);
    await observed.done;
    expect(calls).toBe(1); expect(a.pid).toBeUndefined(); expect(a.exitCode).toBe(error.errno);
    expect(a.stdio).toEqual(reference.stdio);
    expect(a.stdin).toBe(null); expect(a.stdout).toBe(null); expect(a.stderr).toBe(null);
    expect(observed.events.some((e: any[]) => e[0] === 'exit')).toBe(false);
    expect(observed.events.filter((e: any[]) => e[0] === 'close')).toHaveLength(1);
    expect(a.kill(0)).toBe(false);
  });
  it('keeps an exceptional wait failure visible without emitting successful exit', async () => {
    const candidate = fixture.create({ waitError: { errno: -constants.errno.ECHILD, code: 'ECHILD', syscall: 'waitpid' } });
    try {
      const child = candidate.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      const observed = trace(child); let calls = 0;
      const callback = new Promise(resolve => candidate.runWithCallback(child, 'fixture', (e: any) => { calls++; resolve(e); }));
      const e: any = await callback;
      expect(e.code).toBe('ECHILD'); expect(e.syscall).toBe('waitpid'); expect(e.pid).toBe(child.pid);
      await observed.done;
      expect(calls).toBe(1); expect(child.exitCode).toBe(null); expect(child.signalCode).toBe(null);
      expect(observed.events.some((e: any[]) => e[0] === 'exit')).toBe(false);
      expect(observed.events.filter((e: any[]) => e[0] === 'close')).toEqual([['close', null, null]]);
    } finally { await candidate.close(); }
  });
});
