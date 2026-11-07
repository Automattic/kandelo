import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { Writable } from 'node:stream';
import * as nativeUtil from 'node:util';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../../third_party/node-core/node-core.js', import.meta.url), 'utf8');
const createValues = Function(`${bundle}; return _createNodeValuesPlatform;`)();
const values = createValues({
  process: { platform: 'kandelo', emitWarning() {} }, Buffer,
  util: { types: nativeUtil.types, getSystemErrorName: nativeUtil.getSystemErrorName },
  inspection: nativeUtil, signals: constants.signals, os: {}, getDOMException: () => DOMException,
});
function subject(errno?: number, code?: string) {
  const start = source.indexOf('        child.kill = function (sig) {');
  const end = source.indexOf('\n        return child;', start);
  if (start < 0 || end < start) throw Error('Child kill source boundary missing');
  const calls: number[][] = [], errors: any[] = [];
  const child = Object.assign(new EventEmitter(), { killed: false });
  child.on('error', error => errors.push(error));
  const native = { __kandeloKill(pid: number, signal: number) {
    calls.push([pid, signal]);
    if (errno !== undefined) throw Object.assign(Error('native kill failure'), { errno, code });
    return 0;
  } };
  const exit = Function('child', '_nn', '_nodeValues', 'pid',
    'let exited = false;' + source.slice(start, end) + ';return () => { exited = true; };')(
    child, native, values, 42);
  return { child: child as any, calls, errors, exit };
}
function reference(code?: string) {
  // Native policy control, with only the OS handle boundary substituted.
  const child: any = Object.setPrototypeOf(new EventEmitter(), ChildProcess.prototype);
  child.killed = false;
  const errors: any[] = [], calls: number[] = [];
  child.on('error', (error: any) => errors.push(error));
  const errno = code === undefined ? 0 : [...nativeUtil.getSystemErrorMap()].find(([, entry]) => entry[0] === code)![0];
  child._handle = { kill(signal: number) { calls.push(signal); return errno; } };
  return { child, errors, calls };
}
function result(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (error: any) { return { name: error.name, code: error.code, syscall: error.syscall }; }
}

describe.skipIf(process.versions.node !== target.version)('child signal and exit ownership', () => {
  it('preserves zero probes, defaults and normalized signals', () => {
    for (const signal of [undefined, 0, 'SIGTERM', 'sigterm', constants.signals.SIGTERM]) {
      const actual = subject(), expected = reference();
      expect(result(() => actual.child.kill(signal))).toEqual(result(() => expected.child.kill(signal)));
      expect(actual.calls.map(([, sig]) => sig)).toEqual(expected.calls);
      expect(actual.child.killed).toBe(expected.child.killed);
    }
    expect(subject().child.kill(0)).toBe(true);
  });

  it('rejects unknown signals before entering native kill', () => {
    for (const signal of [null, false, '', 'UNKNOWN', 999, -1, {}, Symbol('signal')]) {
      const actual = subject(), expected = reference();
      expect(result(() => actual.child.kill(signal))).toEqual(result(() => expected.child.kill(signal)));
      expect(actual.calls).toEqual([]);
      expect(actual.child.killed).toBe(false);
    }
  });

  it('preserves ESRCH, EINVAL, ENOSYS and EPERM policy', () => {
    for (const [errno, code] of [[constants.errno.ESRCH, 'ESRCH'], [constants.errno.EINVAL, 'EINVAL'], [constants.errno.ENOSYS, 'ENOSYS'], [constants.errno.EPERM, 'EPERM']] as const) {
      const actual = subject(errno, code), expected = reference(code);
      expect(result(() => actual.child.kill(0))).toEqual(result(() => expected.child.kill(0)));
      expect(actual.child.killed).toBe(expected.child.killed);
      expect(actual.errors.map(error => [error.code, error.syscall]))
        .toEqual(expected.errors.map((error: any) => [error.code, error.syscall]));
      if (actual.errors.length) expect(actual.errors[0].errno).toBe(-errno);
    }
  });

  it('does not signal a pid after the child owner has reaped it', () => {
    const actual = subject(); actual.exit();
    expect(actual.child.kill(0)).toBe(false);
    expect(actual.calls).toEqual([]);
    expect(actual.child.killed).toBe(false);
  });

  it('destroys stdin through its stream owner before notifying exit', async () => {
    const start = source.indexOf('        const waitRequest = _nn.__kandeloWaitPid(pid);');
    const end = source.indexOf('\n\n        child.kill =', start);
    if (start < 0 || end < start) throw Error('Child wait source boundary missing');
    const order: string[] = [];
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); },
      destroy(error, callback) { order.push('close-owned-write-fd'); callback(error); } });
    const child = Object.assign(new EventEmitter(), { stdin, stdout: null, stderr: null });
    child.on('exit', () => { expect(stdin.destroyed).toBe(true); order.push('exit'); });
    const tickCallbacks: Array<() => void> = [];
    const completion = Promise.resolve({ code: 0, signal: null });
    Function('_nn', 'child', 'process', '_maybeClose', 'pid',
      'let exited=false, exitInfo=null;' + source.slice(start, end))(
      { __kandeloWaitPid: () => completion }, child,
      { nextTick: (fn: () => void) => tickCallbacks.push(fn) }, () => order.push('maybe-close'), 42);
    await completion;
    expect(order).toEqual(['close-owned-write-fd', 'exit', 'maybe-close']);
    expect(tickCallbacks).toHaveLength(1);
    tickCallbacks[0]();
    expect(order.filter(x => x === 'close-owned-write-fd')).toHaveLength(1);
  });
});
