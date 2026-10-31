import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { nodeModuleEntryFiles } from './fixtures/node-module-entrypoints';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing module source boundary');
  return source.slice(a, b);
}
function loader() {
  const files: Record<string, string> = {
    '/main.cjs': 'exports.self=module;exports.main=require.main;exports.child=require("./child.cjs");',
    '/child.cjs': 'exports.main=require.main;exports.beforeLoaded=require.main.loaded;',
  };
  const proc = { cwd: () => '/', mainModule: undefined };
  const context = {
    path, process: proc, Module: { _nodeModulePaths: () => [] },
    std: { loadFile: (name: string) => files[name] ?? null },
    _builtinModules: {}, _moduleRealpath: (name: string) => name,
    _nearestPackageType: () => '',
    _resolveFile: (id: string, dir: string) => files[path.resolve(dir, id)] !== undefined ? path.resolve(dir, id) : null,
    _nodeNative: { evalScriptAsFunction: (code: string) => runInNewContext(code) },
  };
  return { proc, make: runInNewContext(section('const _moduleCache =', 'function _nearestPackageType(') + ';_makeRequire;', context) };
}

describe('Node module entry ownership', () => {
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
