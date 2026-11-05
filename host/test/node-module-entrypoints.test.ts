import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { nodeModuleEntryFiles } from './fixtures/node-module-entrypoints';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing module source boundary');
  return source.slice(a, b);
}
function loader(additionalFiles: Record<string, string> = {}) {
  const files: Record<string, string> = {
    '/main.cjs': 'exports.self=module;exports.main=require.main;exports.child=require("./child.cjs");',
    '/child.cjs': 'exports.main=require.main;exports.beforeLoaded=require.main.loaded;',
    ...additionalFiles,
  };
  return createRequire(import.meta.url)('./fixtures/node-module-records.cjs').create({ files, cwd: '/' });
}

describe('Node module entry ownership', () => {
  it('binds the initial exports object as receiver in strict and loose modules', () => {
    const { make } = loader({
      '/strict.cjs': '"use strict";const initial=exports;module.exports={same:this===initial&&this===exports};',
      '/loose.cjs': 'module.exports={same:this===exports&&this===module.exports};',
    });
    expect(make('/entry.cjs')('/strict.cjs').same).toBe(true);
    expect(make('/entry.cjs')('/loose.cjs').same).toBe(true);
  });

  it('evicts compilation failures so corrected source can be required', () => {
    const { make, files } = loader({ '/broken.cjs': 'const = ;' });
    const require = make('/entry.cjs');
    expect(() => require('/broken.cjs')).toThrow();
    expect(require.cache['/broken.cjs']).toBeUndefined();
    files['/broken.cjs'] = 'module.exports={recovered:true};';
    expect(require('/broken.cjs').recovered).toBe(true);
    expect(require.cache['/broken.cjs'].loaded).toBe(true);
  });

  it('strips a JSON BOM and adds the filename to parse errors without caching failure', () => {
    const { make, files } = loader({ '/data.json': '\ufeff{"value":1}', '/broken.json': '\ufeff{"value":}' });
    const require = make('/entry.cjs');
    expect(require('/data.json')).toEqual({ value: 1 });
    expect(require('/data.json')).toBe(require('/data.json'));
    expect(() => require('/broken.json')).toThrow('/broken.json: ');
    expect(require.cache['/broken.json']).toBeUndefined();
    files['/broken.json'] = '{"fixed":true}';
    expect(require('/broken.json')).toEqual({ fixed: true });
  });

  it('publishes the main module before children execute and preserves cache identity', () => {
    const { make, proc } = loader();
    const exports = make('/main.cjs', true)('/main.cjs');
    expect(exports.main).toBe(exports.self);
    expect(exports.child.main).toBe(exports.self);
    expect(exports.self.id).toBe('.');
    expect(exports.child.beforeLoaded).toBe(false);
    expect(exports.self.loaded).toBe(true);
    expect(proc.mainModule).toBe(exports.self);
    expect(make('/later.cjs').main).toBe(exports.self);
    expect(make('/main.cjs')('/main.cjs')).toBe(exports);
  });

  it('leaves require.main absent in eval and ESM without a CommonJS entry', () => {
    const { make, proc } = loader();
    expect(make('/repl').main).toBeUndefined();
    expect(proc.mainModule).toBeUndefined();
  });

  it('submits ESM unchanged and returns to the owner while the graph is pending', async () => {
    let finish!: () => void;
    const calls: string[] = [];
    const module = new Promise<void>(resolve => { finish = resolve; });
    const realm = runInNewContext(section('let _esmMainPending =', 'function _runMainScriptIfPresent(') +
      ';({run:_runEsmMain,pending:()=>_esmMainPending});', {
      _nodeNative: { importModule: (filename: string) => { calls.push(filename); return module; } },
      process: {}, console, _formatThrownFailure: String,
    });
    expect(realm.run('/entry.mjs')).toBeUndefined();
    expect(calls).toEqual(['/entry.mjs']);
    expect(realm.pending()).toBe(true);
    finish(); await module;
    expect(realm.pending()).toBe(false);
  });
});

describe.skipIf(process.versions.node !== target.version)('exact native module fixture controls', () => {
  for (const [entry, status, marker] of [
    ['main.cjs', 0, 'node-cjs-entry-ok'], ['esm-main.mjs', 0, 'node-esm-entry-ok'],
    ['unsettled.mjs', 13, ''], ['failure.mjs', 1, ''],
  ] as const) {
    it(`checks ${entry} on Node ${target.version}`, () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'node-module-entry-'));
      try {
        for (const [name, contents] of Object.entries(nodeModuleEntryFiles)) writeFileSync(path.join(directory, name), contents);
        const result = spawnSync(process.execPath, [path.join(directory, entry)], { encoding: 'utf8', timeout: 5000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(status);
        if (marker) expect(result.stdout).toContain(marker);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
});
