import { readFileSync } from 'node:fs';
import * as tty from 'node:tty';
import * as readline from 'node:readline';
import * as promises from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function subject() {
  return createRequire(import.meta.url)('./fixtures/node-readline-interface.cjs').create();
}
function failure(fn: () => unknown) {
  try { fn(); return undefined; } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; }
}

describe.skipIf(process.versions.node !== target.version)('pinned cursor and transaction source', () => {
  it('forwards exact control bytes, callbacks and write return values', () => {
    function run(api: any) {
      const result: unknown[] = [], callback = () => {}, token = Symbol('backpressure');
      const stream = { write(data: string, cb: unknown) { result.push([data, cb === callback]); return token; } };
      for (const [method, args] of [['cursorTo', [2, 3]], ['cursorTo', [1.5]], ['moveCursor', [-2.5, 3]],
        ['clearLine', [-1]], ['clearLine', [1]], ['clearLine', [0]], ['clearScreenDown', []]] as const) {
        result.push(api[method](stream, ...args, callback) === token);
      }
      return result;
    }
    expect(run(subject().callbacks)).toEqual(run(readline));
  });

  it('waits for real Writable completion and preserves backpressure', async () => {
    async function run(api: any) {
      let finish!: () => void, callback = false;
      const sink = new Writable({ highWaterMark: 1, write(_data, _encoding, cb) { finish = cb; } });
      let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; });
      try {
        const result = api.cursorTo(sink, 1, () => { callback = true; resolve(); });
        const before = [result, callback]; finish(); await done;
        return [before, callback];
      } finally { sink.destroy(); }
    }
    expect(await run(subject().callbacks)).toEqual(await run(readline));
  });

  it('matches validation and queues null-stream completion on nextTick', async () => {
    const api = subject().callbacks;
    for (const [method, args] of [['cursorTo', [NaN]], ['cursorTo', [undefined, 2]],
      ['cursorTo', [0, NaN]], ['cursorTo', [1, 2, null]], ['moveCursor', [1, 2, 'bad']],
      ['clearLine', [0, {}]], ['clearScreenDown', [false]]] as const) {
      expect(failure(() => api[method](null, ...args))).toEqual(failure(() => (readline[method] as Function)(null, ...args)));
    }
    async function run(callbacks: any) {
      const events: unknown[] = [];
      await new Promise<void>(resolve => {
        const result = callbacks.cursorTo(null, 1, (error: unknown) => { events.push(error); resolve(); });
        events.push(result, 'returned');
      }); return events;
    }
    expect(await run(api)).toEqual(await run(readline));
  });

  it('owns transactional bytes, rollback and commit completion', async () => {
    async function run(api: any) {
      const chunks: string[] = []; let finish!: () => void;
      const sink = new Writable({ write(chunk, _encoding, cb) { chunks.push(chunk.toString()); finish = cb; } });
      try {
        const rl = new api.Readline(sink);
        expect(rl.cursorTo(4).clearLine(0).rollback()).toBe(rl);
        rl.cursorTo(2, 3).moveCursor(-1, 2).clearLine(1).clearScreenDown();
        let complete = false; const done = rl.commit().then(() => { complete = true; });
        const before = [chunks.slice(), complete]; finish(); await done;
        return [before, chunks, complete];
      } finally { sink.destroy(); }
    }
    expect(await run(subject().promises)).toEqual(await run(promises));
  });

  it('matches transactional validation and autoCommit scheduling', async () => {
    const api = subject().promises;
    for (const scenario of [(R: any) => new R({}), (R: any) => new R(new Writable(), { autoCommit: 'yes' }),
      (R: any) => new R(new Writable()).cursorTo(NaN), (R: any) => new R(new Writable()).clearLine(2),
      (R: any) => new R(new Writable()).moveCursor('1', 0)]) {
      expect(failure(() => scenario(api.Readline))).toEqual(failure(() => scenario(promises.Readline)));
    }
    async function run(namespace: any) {
      const events: string[] = []; let resolve!: () => void; const written = new Promise<void>(r => { resolve = r; });
      const sink = new Writable({ write(bytes, _encoding, cb) { events.push(bytes.toString()); cb(); resolve(); } });
      try { const rl = new namespace.Readline(sink, { autoCommit: true }); rl.cursorTo(1); events.push('returned'); await written; return events; }
      finally { sink.destroy(); }
    }
    expect(await run(api)).toEqual(await run(promises));
  });

  it('validates tty descriptors without coercion before native lookup', () => {
    const api = subject();
    for (const fd of [-1, 0, 1, 2, 2147483647, 2147483648, 1.5, NaN, Infinity, '1', null, undefined, {}, 1n, Symbol('fd')]) {
      expect(api.isatty(fd)).toBe(tty.isatty(fd as any));
    }
  });
});
